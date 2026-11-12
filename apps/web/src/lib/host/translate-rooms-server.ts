import "server-only";
import { NextResponse } from "next/server";
import { createExperienceTranslateRoomsClient, type ExperienceTranslateRoomsFailure, type StandaloneTranslateLanguage } from "@niho-experience/api-client/experience-translate-rooms";
import { isExperienceTranslateRoomPathId } from "@niho-experience/api-client/experience-translate-rooms-schema";
import { StoreAccessDeniedError, StoreNotFoundError, StoreValidationError, type HostGuestBooking } from "@niho-experience/experience-store";
import { todayInJapan } from "@/host/format";
import { guestNeedsInterpretation } from "@/host/translate";
import { asTranslateOwner } from "@/host/site-bookings-server";
import { HOST_SESSION_ENDED_TEXT } from "@/host/errors";
import { MOCK_TODAY } from "@/host/mock/bookings";
import { mockExperienceBookings } from "@/host/mock/experience-reservations";
import { SITE_BOOKING_LOAD_FAILED_TEXT } from "@/host/site-bookings";
import { config } from "@/lib/config";
import { mutationFromSameOrigin } from "./relay";
import { clearSessionCookie, experienceHostServiceIdToken, isHostMock, loadHostProviders, nihoApiFetch, readHostSession, siteOrigin } from "./server";
import { accessTokenUsable } from "./session";

/*
 * Server boundary of 対面通訳 (#181), after provider-operations-server.ts: the host's sealed
 * session is the only credential, NIHO decides membership and role on every call, and the
 * browser only ever sees the projected DTOs (src/host/translate.ts). Every answer is
 * private, no-store: an invite URL must not land in a cache.
 */

const HEADERS = { "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-robots-tag": "noindex, nofollow" };
/** A POST here carries nothing. Anything beyond an empty body or `{}` is refused, so no field can be smuggled to NIHO. */
const MAX_BODY_BYTES = 1024;

/** Reads at most `limit` bytes without first buffering an attacker-controlled body. */
async function readBoundedTranslateBody(request: Request, limit = MAX_BODY_BYTES): Promise<string | null> {
  const declaredHeader = request.headers.get("content-length");
  const declared = declaredHeader === null ? null : Number(declaredHeader);
  const body = request.body;
  if (declared !== null && (!Number.isFinite(declared) || declared < 0 || declared > limit)) {
    try { await body?.cancel(); } catch { /* The body may already be closed by the runtime. */ }
    return null;
  }
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        try { await reader.cancel(); } catch { /* Cancellation is best-effort. */ }
        return null;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { return null; }
  } catch {
    try { await reader.cancel(); } catch { /* Cancellation is best-effort. */ }
    return null;
  } finally {
    reader.releaseLock();
  }
}

/** The mock always has synthetic rooms; http opens the selected NIHO translate API behind its own flag. */
export function translateRoomsEnabled(): boolean {
  return config.hostConsoleEnabled && (config.apiMode === "mock" || config.experienceTranslateApiEnabled || config.experienceTranslateStandaloneApiEnabled);
}

/** Booking screens keep their existing NIHO-session API gate. */
export function siteTranslateRoomsEnabled(): boolean {
  return config.hostConsoleEnabled && (config.apiMode === "mock" || config.experienceTranslateApiEnabled);
}

/** What the booking screens get: the day in Japan 通訳を始める counts from, or null while the BFF is closed. */
export function translateRoomsEntry(): { today: string } | null {
  return siteTranslateRoomsEnabled() ? { today: todayInJapan(Date.now()) } : null;
}

export function translateRoomsJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: HEADERS });
}

export function translateRoomsMutationAllowed(request: Request): boolean {
  return mutationFromSameOrigin(request.method, request.headers, siteOrigin());
}

/** True when the request body is empty or an empty JSON object. */
export async function readEmptyTranslateBody(request: Request): Promise<boolean> {
  const text = await readBoundedTranslateBody(request);
  if (text === null) return false;
  if (text === "") return true;
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === 0;
  } catch { return false; }
}

/** The standalone create body is exactly `{hostLanguage:"ja"|"en"}` and stays small. */
export async function readStandaloneTranslateCreateBody(request: Request): Promise<{ hostLanguage: StandaloneTranslateLanguage } | null> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") return null;
  const text = await readBoundedTranslateBody(request);
  if (text === null) return null;
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (Object.keys(record).length !== 1 || (record.hostLanguage !== "ja" && record.hostLanguage !== "en")) return null;
    return { hostLanguage: record.hostLanguage };
  } catch { return null; }
}

/** Check the sealed session and current Experience OWNER membership for every standalone request. */
export async function loadStandaloneTranslateRoomsClient(localProviderId: string) {
  if (!translateRoomsEnabled() || !isExperienceTranslateRoomPathId(localProviderId)) {
    return { ok: false as const, response: translateRoomsJson({ error: "not_found" }, 404) };
  }
  const current = await readHostSession();
  if (!current) return { ok: false as const, response: translateRoomsJson({ error: "unauthenticated" }, 401) };
  if (config.apiMode === "http") {
    if (current.kind === "experience" && !config.experienceTranslateStandaloneApiEnabled) {
      return { ok: false as const, response: translateRoomsJson({ error: "not_found" }, 404) };
    }
    if (current.kind === "niho" && (!config.experienceTranslateApiEnabled || !accessTokenUsable(current, Date.now()))) {
      return { ok: false as const, response: translateRoomsJson({ error: "session_refresh_required" }, 401) };
    }
  }
  const identity = await loadHostProviders();
  if (identity.status === "signed-out" || identity.status === "refresh") {
    return { ok: false as const, response: translateRoomsJson({ error: "session_refresh_required" }, 401) };
  }
  if (identity.status === "rejected") {
    const response = translateRoomsJson({ error: "session_ended" }, 401);
    clearSessionCookie(response);
    return { ok: false as const, response };
  }
  if (identity.status !== "ok") return { ok: false as const, response: translateRoomsJson({ error: "unavailable" }, 502) };
  const provider = identity.providers.find((item) => item.id === localProviderId);
  if (provider?.memberRole !== "OWNER") {
    return { ok: false as const, response: translateRoomsJson({ error: "not_found" }, 404) };
  }
  try {
    if (current.kind === "experience") {
      const serviceIdToken = await experienceHostServiceIdToken();
      return {
        ok: true as const,
        serviceAuth: true as const,
        providerApiId: localProviderId,
        client: createExperienceTranslateRoomsClient({
          nihoWebOrigin: config.nihoWebOrigin,
          auth: { kind: "experience-service", serviceIdToken },
        }),
      };
    }
    if (!isExperienceTranslateRoomPathId(provider.legacyProviderId)) {
      return { ok: false as const, response: translateRoomsJson({ error: "not_found" }, 404) };
    }
    return {
      ok: true as const,
      serviceAuth: false as const,
      providerApiId: provider.legacyProviderId,
      client: createExperienceTranslateRoomsClient({
        nihoWebOrigin: config.nihoWebOrigin,
        auth: { kind: "niho", accessToken: current.accessToken },
        fetch: nihoApiFetch(current),
      }),
    };
  } catch {
    return { ok: false as const, response: translateRoomsJson({ error: "unavailable" }, 502) };
  }
}

export type SiteTranslateRoomAction = "create" | "status" | "end";

/** createだけに適用するExperience DB側の開始条件。status/endは取消や日付変更後も自分のroomへ届く。 */
export function siteTranslateBookingEligible(booking: Pick<HostGuestBooking, "status" | "cancelledAtUtc" | "language" | "localDate">, today: string): boolean {
  return booking.status === "CONFIRMED"
    && booking.cancelledAtUtc === null
    && guestNeedsInterpretation(booking.language)
    && booking.localDate >= today;
}

/** NIHO OWNERとExperience DBの予約所属を毎回照合してからsite-booking用NIHO clientを返す。 */
export async function loadSiteTranslateRoomsClient(providerId: string, bookingId: string, action: SiteTranslateRoomAction) {
  if (!siteTranslateRoomsEnabled()) return { ok: false as const, response: translateRoomsJson({ error: "not_found" }, 404) };
  const current = await readHostSession();
  const session = current?.kind === "experience" ? null : current;
  if (!session) return { ok: false as const, response: translateRoomsJson({ error: "unauthenticated" }, 401) };
  if (!accessTokenUsable(session, Date.now())) return { ok: false as const, response: translateRoomsJson({ error: "session_refresh_required" }, 401) };

  let booking: HostGuestBooking;
  if (isHostMock()) {
    const providers = await loadHostProviders();
    const provider = providers.status === "ok" ? providers.providers.find((item) => item.id === providerId) : null;
    if (provider?.memberRole !== "OWNER") {
      return { ok: false as const, response: translateRoomsJson({ error: "not_found" }, 404) };
    }
    const found = mockExperienceBookings(providerId).find((item) => item.publicBookingId === bookingId);
    if (!found) return { ok: false as const, response: translateRoomsJson({ error: "not_found" }, 404) };
    booking = found;
  } else {
    const owner = await asTranslateOwner(providerId);
    if (!owner.ok) {
      if (owner.message === HOST_SESSION_ENDED_TEXT) return { ok: false as const, response: translateRoomsJson({ error: "session_refresh_required" }, 401) };
      if (owner.message === SITE_BOOKING_LOAD_FAILED_TEXT) return { ok: false as const, response: translateRoomsJson({ error: "store_unavailable" }, 502) };
      return { ok: false as const, response: translateRoomsJson({ error: "not_found" }, 404) };
    }
    try {
      booking = await owner.bookings.getGuestBookingForHost(owner.actor, bookingId);
    } catch (error) {
      if (error instanceof StoreNotFoundError || error instanceof StoreValidationError || error instanceof StoreAccessDeniedError) {
        return { ok: false as const, response: translateRoomsJson({ error: "not_found" }, 404) };
      }
      return { ok: false as const, response: translateRoomsJson({ error: "store_unavailable" }, 502) };
    }
  }
  const today = isHostMock() ? MOCK_TODAY : todayInJapan(Date.now());
  if (action === "create" && !siteTranslateBookingEligible(booking, today)) {
    return { ok: false as const, response: translateRoomsJson({ error: "booking_not_eligible" }, 409) };
  }
  try {
    return {
      ok: true as const,
      client: createExperienceTranslateRoomsClient({
        nihoWebOrigin: config.nihoWebOrigin,
        auth: { kind: "niho", accessToken: session.accessToken },
        fetch: nihoApiFetch(session),
      }),
    };
  } catch {
    return { ok: false as const, response: translateRoomsJson({ error: "unavailable" }, 502) };
  }
}

/** NIHO's refusal in this site's words. A 404 stays `not_found`: the booking is not this provider's, the room is gone, or NIHO has no translate rooms yet. */
export function translateRoomsFailure(failure: ExperienceTranslateRoomsFailure, options: { serviceAuth?: boolean } = {}): NextResponse {
  if (failure.kind === "invalid_request") return translateRoomsJson({ error: "invalid_input" }, 400);
  if (failure.kind === "rejected") {
    if (options.serviceAuth) return translateRoomsJson({ error: "upstream_unavailable" }, 502);
    const response = translateRoomsJson({ error: failure.status === 401 ? "session_ended" : "permission_ended" }, failure.status);
    if (failure.status === 401) clearSessionCookie(response);
    return response;
  }
  if (failure.kind === "not_found") return translateRoomsJson({ error: "not_found" }, 404);
  if (failure.kind === "conflict") return translateRoomsJson({ error: "conflict" }, 409);
  if (failure.kind === "limited") return translateRoomsJson({ error: "limited" }, 429);
  if (failure.kind === "network_error") return translateRoomsJson({ error: "upstream_unavailable" }, 502);
  return translateRoomsJson({ error: "unexpected_upstream_response" }, 502);
}
