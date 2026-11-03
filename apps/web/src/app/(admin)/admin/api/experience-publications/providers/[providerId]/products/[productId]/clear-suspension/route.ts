import { StoreConflictError, StoreNotFoundError, StoreValidationError } from "@niho-experience/experience-store";
import { adminMutationAllowed, clearAdminHttpSessionCookie, loadAdminHttpSession } from "@/lib/admin/server";
import { config } from "@/lib/config";
import { experiencePublicationRepository } from "@/lib/experience/store-server";
import { readBoundedJson, ResponseBodyTooLarge } from "@/lib/read-bounded-json";

type Context = { params: Promise<{ providerId: string; productId: string }> };
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/;
const VERSION = /^[1-9][0-9]{0,15}$/;
const BODY_LIMIT = 2_048;
const HEADERS = { "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-robots-tag": "noindex, nofollow" };
function json(body: unknown, status = 200): Response { return Response.json(body, { status, headers: HEADERS }); }

export async function POST(request: Request, context: Context): Promise<Response> {
  if (!config.experiencePublicationsEnabled || config.apiMode !== "http" || !config.adminSupportConsoleEnabled) return json({ error: { code: "NOT_FOUND" } }, 404);
  if (!adminMutationAllowed(request)) return json({ error: { code: "FORBIDDEN" } }, 403);
  const { providerId, productId } = await context.params;
  if (!ID.test(providerId) || !ID.test(productId) || new URL(request.url).search
    || request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") return json({ error: { code: "INVALID_INPUT" } }, 400);
  let body: unknown;
  try { body = await readBoundedJson(request, BODY_LIMIT, { fatalUtf8: true }); }
  catch (error) { return json({ error: { code: "INVALID_INPUT" } }, error instanceof ResponseBodyTooLarge ? 413 : 400); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: { code: "INVALID_INPUT" } }, 400);
  const input = body as Record<string, unknown>;
  if (Object.keys(input).length !== 1 || !Object.hasOwn(input, "expectedStateVersion")
    || typeof input.expectedStateVersion !== "number" || !Number.isSafeInteger(input.expectedStateVersion)
    || input.expectedStateVersion < 1 || !VERSION.test(String(input.expectedStateVersion))) return json({ error: { code: "INVALID_INPUT" } }, 400);

  const session = await loadAdminHttpSession();
  if (session.status !== "ok") {
    const response = json({ error: { code: session.status === "error" ? "READINESS_UNAVAILABLE" : session.status === "refresh" ? "SESSION_REFRESH_REQUIRED" : "SESSION_ENDED" } }, session.status === "error" ? 503 : 401);
    if (session.status === "rejected") clearAdminHttpSessionCookie(response);
    return response;
  }
  const repository = experiencePublicationRepository();
  if (!repository) return json({ error: { code: "STORE_UNAVAILABLE" } }, 503);
  try {
    const state = await repository.clearOperationsSuspension({ nihoUserId: session.verified.actor.id }, providerId, productId, input.expectedStateVersion);
    return json({ publication: {
      state: state.ownerResumeRequired ? "RESUME_REQUIRED" : state.selfStoppedAtUtc ? "SELF_STOPPED" : "PUBLISHED",
      stateVersion: state.version, firstPublishedAtUtc: state.firstPublishedAtUtc,
      selfStoppedAtUtc: state.selfStoppedAtUtc, operationsSuspended: false, ownerResumeRequired: state.ownerResumeRequired,
    } });
  } catch (error) {
    if (error instanceof StoreConflictError) return json({ error: { code: "VERSION_CONFLICT" } }, 409);
    if (error instanceof StoreNotFoundError) return json({ error: { code: "NOT_FOUND" } }, 404);
    if (error instanceof StoreValidationError) return json({ error: { code: "INVALID_INPUT" } }, 400);
    console.error("Experience publication suspension clear failed", { error: error instanceof Error ? error.name : typeof error });
    return json({ error: { code: "STORE_UNAVAILABLE" } }, 503);
  }
}
