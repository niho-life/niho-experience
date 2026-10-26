import "server-only";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  createExperiencePreparationAdminApiClient,
  createExperiencePreparationHostApiClient,
  createExperiencePreparationReviewApiClient,
  type ExperiencePreparationAdminApiClient,
  type ExperiencePreparationFailure,
  type ExperiencePreparationHostApiClient,
} from "@niho-experience/api-client/experience-preparations";
import { config } from "@/lib/config";
import { clearAdminHttpSessionCookie, loadAdminHttpSession } from "@/lib/admin/server";
import { cookieSealer } from "@/lib/host/cookie-seal";
import { clearSessionCookie, readHostSession, siteOrigin } from "@/lib/host/server";
import { idTokenUsable } from "@/lib/host/session";
import { mutationFromSameOrigin } from "@/lib/host/relay";
import {
  decodePreparationReviewGrant,
  encodePreparationReviewGrant,
  preparationReviewCookieOptions,
  PREPARATION_REVIEW_COOKIE,
  PREPARATION_REVIEW_COOKIE_PATH,
  type PreparationReviewGrant,
} from "./review-session";

export const isPreparationHttpEnabled = () => config.apiMode === "http" && config.hostConsoleEnabled && config.adminSupportConsoleEnabled && config.experienceAssistedLaunchApiEnabled;
export const isPreparationPreviewEnabled = () => config.apiMode === "mock" && config.hostConsoleEnabled && config.adminSupportConsoleEnabled && config.experienceAssistedLaunchPreviewEnabled;
export const isPreparationUiEnabled = () => isPreparationHttpEnabled() || isPreparationPreviewEnabled();
export const preparationReviewSealer = () => cookieSealer(config.hostSessionSecret, "experience-preparation-review-token");

const SECURITY_HEADERS = {
  "cache-control": "private, no-store",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex, nofollow",
};

export function preparationJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: SECURITY_HEADERS });
}

export function preparationEmpty(status = 204): NextResponse {
  return new NextResponse(null, { status, headers: SECURITY_HEADERS });
}

export function preparationMutationAllowed(request: Request): boolean {
  return mutationFromSameOrigin(request.method, request.headers, siteOrigin());
}

export async function readBoundedJson(request: Request, maxBytes: number): Promise<{ ok: true; value: unknown } | { ok: false }> {
  if (new URL(request.url).search) return { ok: false };
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") return { ok: false };
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false };
  let text: string;
  try { text = await request.text(); } catch { return { ok: false }; }
  if (Buffer.byteLength(text) > maxBytes) return { ok: false };
  try { return { ok: true, value: JSON.parse(text) as unknown }; } catch { return { ok: false }; }
}

export function preparationFailureJson(failure: ExperiencePreparationFailure, actor: "admin" | "host" | "review") {
  let response: NextResponse;
  if (failure.kind === "invalid_request") response = preparationJson({ error: "invalid_input" }, 400);
  else if (failure.kind === "rejected") response = preparationJson({ error: "signed_out" }, 401);
  else if (failure.kind === "not_found") response = preparationJson({ error: "not_found" }, 404);
  else if (failure.kind === "conflict") response = preparationJson({ error: "conflict", reason: failure.reason }, 409);
  else if (failure.kind === "unprocessable") response = preparationJson({ error: "unprocessable", reason: failure.reason }, 422);
  else response = preparationJson({ error: "unavailable" }, 503);
  if (failure.kind === "rejected" && actor === "admin") clearAdminHttpSessionCookie(response);
  if (failure.kind === "rejected" && actor === "host") clearSessionCookie(response);
  return response;
}

export async function loadPreparationAdminClient(): Promise<{ ok: true; client: ExperiencePreparationAdminApiClient } | { ok: false; response: NextResponse }> {
  if (!isPreparationHttpEnabled()) return { ok: false, response: preparationJson({ error: "not_found" }, 404) };
  const load = await loadAdminHttpSession();
  if (load.status === "ok") return { ok: true, client: createExperiencePreparationAdminApiClient({ nihoWebOrigin: config.nihoWebOrigin, idToken: load.session.idToken, fetch }) };
  if (load.status === "error") return { ok: false, response: preparationJson({ error: "unavailable" }, 503) };
  const response = preparationJson({ error: load.status === "refresh" ? "refresh_required" : "signed_out" }, 401);
  if (load.status === "rejected") clearAdminHttpSessionCookie(response);
  return { ok: false, response };
}

export async function loadPreparationHostClient(): Promise<{ ok: true; client: ExperiencePreparationHostApiClient } | { ok: false; response: NextResponse }> {
  if (!isPreparationHttpEnabled()) return { ok: false, response: preparationJson({ error: "not_found" }, 404) };
  const session = await readHostSession();
  if (!session) return { ok: false, response: preparationJson({ error: "signed_out" }, 401) };
  if (!idTokenUsable(session, Date.now())) return { ok: false, response: preparationJson({ error: "refresh_required" }, 401) };
  return { ok: true, client: createExperiencePreparationHostApiClient({ nihoWebOrigin: config.nihoWebOrigin, idToken: session.idToken, fetch }) };
}

export function preparationReviewClient() {
  return createExperiencePreparationReviewApiClient({ nihoWebOrigin: config.nihoWebOrigin, fetch });
}

export async function readPreparationReviewGrant(): Promise<PreparationReviewGrant | null> {
  if (!isPreparationHttpEnabled()) return null;
  const jar = await cookies();
  return decodePreparationReviewGrant(preparationReviewSealer(), jar.get(PREPARATION_REVIEW_COOKIE)?.value, Date.now());
}

export function setPreparationReviewGrant(response: NextResponse, grant: PreparationReviewGrant) {
  const now = Date.now();
  response.cookies.set(PREPARATION_REVIEW_COOKIE, encodePreparationReviewGrant(preparationReviewSealer(), grant), preparationReviewCookieOptions(grant.expiresAt, now));
}

export function clearPreparationReviewGrant(response: NextResponse) {
  response.cookies.set(PREPARATION_REVIEW_COOKIE, "", { ...preparationReviewCookieOptions(0, Date.now()), path: PREPARATION_REVIEW_COOKIE_PATH });
}
