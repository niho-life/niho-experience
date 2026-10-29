import "server-only";
import { NextResponse } from "next/server";
import { createExperienceTranslateRoomsClient, type ExperienceTranslateRoomsFailure } from "@niho-experience/api-client/experience-translate-rooms";
import { todayInJapan } from "@/host/format";
import { config } from "@/lib/config";
import { mutationFromSameOrigin } from "./relay";
import { clearSessionCookie, nihoApiFetch, readHostSession, siteOrigin } from "./server";
import { idTokenUsable } from "./session";

/*
 * Server boundary of 対面通訳 (#181), after provider-operations-server.ts: the host's sealed
 * session is the only credential, NIHO decides membership and role on every call, and the
 * browser only ever sees the projected DTOs (src/host/translate.ts). Every answer is
 * private, no-store: an invite URL must not land in a cache.
 */

const HEADERS = { "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-robots-tag": "noindex, nofollow" };
/** A POST here carries nothing. Anything beyond an empty body or `{}` is refused, so no field can be smuggled to NIHO. */
const MAX_BODY_BYTES = 1024;

/** The mock always has synthetic rooms; http waits for NIHO's N1b (#19447) behind EXPERIENCE_TRANSLATE_API_ENABLED. */
export function translateRoomsEnabled(): boolean {
  return config.hostConsoleEnabled && (config.apiMode === "mock" || config.experienceTranslateApiEnabled);
}

/** What the booking screens get: the day in Japan 通訳を始める counts from, or null while the BFF is closed. */
export function translateRoomsEntry(): { today: string } | null {
  return translateRoomsEnabled() ? { today: todayInJapan(Date.now()) } : null;
}

export function translateRoomsJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: HEADERS });
}

export function translateRoomsMutationAllowed(request: Request): boolean {
  return mutationFromSameOrigin(request.method, request.headers, siteOrigin());
}

/** True when the request body is empty or an empty JSON object. */
export async function readEmptyTranslateBody(request: Request): Promise<boolean> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (!Number.isFinite(declared) || declared > MAX_BODY_BYTES) return false;
  let text: string;
  try { text = await request.text(); } catch { return false; }
  if (text === "") return true;
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) return false;
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === 0;
  } catch { return false; }
}

export async function loadTranslateRoomsClient() {
  if (!translateRoomsEnabled()) return { ok: false as const, response: translateRoomsJson({ error: "not_found" }, 404) };
  const session = await readHostSession();
  if (!session) return { ok: false as const, response: translateRoomsJson({ error: "unauthenticated" }, 401) };
  if (!idTokenUsable(session, Date.now())) return { ok: false as const, response: translateRoomsJson({ error: "session_refresh_required" }, 401) };
  try {
    return { ok: true as const, client: createExperienceTranslateRoomsClient({ nihoWebOrigin: config.nihoWebOrigin, idToken: session.idToken, fetch: nihoApiFetch(session) }) };
  } catch { return { ok: false as const, response: translateRoomsJson({ error: "unavailable" }, 502) }; }
}

/** NIHO's refusal in this site's words. A 404 stays `not_found`: the booking is not this provider's, the room is gone, or NIHO has no translate rooms yet. */
export function translateRoomsFailure(failure: ExperienceTranslateRoomsFailure): NextResponse {
  if (failure.kind === "invalid_request") return translateRoomsJson({ error: "invalid_input" }, 400);
  if (failure.kind === "rejected") {
    const response = translateRoomsJson({ error: failure.status === 401 ? "session_ended" : "permission_ended" }, failure.status);
    if (failure.status === 401) clearSessionCookie(response);
    return response;
  }
  if (failure.kind === "not_found") return translateRoomsJson({ error: "not_found" }, 404);
  if (failure.kind === "conflict") return translateRoomsJson({ error: "conflict" }, 409);
  if (failure.kind === "network_error") return translateRoomsJson({ error: "upstream_unavailable" }, 502);
  return translateRoomsJson({ error: "unexpected_upstream_response" }, 502);
}
