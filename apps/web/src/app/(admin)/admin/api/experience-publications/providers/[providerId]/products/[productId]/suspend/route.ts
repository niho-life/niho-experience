import { NextResponse } from "next/server";
import { StoreConflictError, StoreNotFoundError, StoreValidationError } from "@niho-experience/experience-store";
import { adminMutationAllowed, clearAdminHttpSessionCookie, loadAdminHttpSession } from "@/lib/admin/server";
import { config } from "@/lib/config";
import { experiencePublicationRepository } from "@/lib/experience/store-server";
import { readBoundedJson, ResponseBodyTooLarge } from "@/lib/read-bounded-json";

type Context = { params: Promise<{ providerId: string; productId: string }> };
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/;
const REASON = /^[A-Z0-9_]{1,80}$/;
const BODY_LIMIT = 2_048;

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-robots-tag": "noindex, nofollow" } });
}

export async function POST(request: Request, context: Context): Promise<NextResponse> {
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
  if (Object.keys(input).some((key) => !["expectedStateVersion", "reasonCode"].includes(key))
    || !Number.isSafeInteger(input.expectedStateVersion) || (input.expectedStateVersion as number) < 1
    || typeof input.reasonCode !== "string" || !REASON.test(input.reasonCode)) return json({ error: { code: "INVALID_INPUT" } }, 400);

  const session = await loadAdminHttpSession();
  if (session.status !== "ok") {
    const response = json({ error: { code: session.status === "error" ? "READINESS_UNAVAILABLE" : session.status === "refresh" ? "SESSION_REFRESH_REQUIRED" : "SESSION_ENDED" } }, session.status === "error" ? 503 : 401);
    if (session.status === "rejected") clearAdminHttpSessionCookie(response);
    return response;
  }
  const repository = experiencePublicationRepository();
  if (!repository) return json({ error: { code: "STORE_UNAVAILABLE" } }, 503);
  try {
    const state = await repository.suspendByOperations({ nihoUserId: session.verified.actor.id }, providerId, productId, input.reasonCode, input.expectedStateVersion as number);
    return json({ publication: {
      state: "OPERATIONS_SUSPENDED", stateVersion: state.version, firstPublishedAtUtc: state.firstPublishedAtUtc,
      selfStoppedAtUtc: state.selfStoppedAtUtc, operationsSuspended: true, ownerResumeRequired: true,
    } });
  } catch (error) {
    if (error instanceof StoreConflictError) return json({ error: { code: "VERSION_CONFLICT" } }, 409);
    if (error instanceof StoreNotFoundError) return json({ error: { code: "NOT_FOUND" } }, 404);
    if (error instanceof StoreValidationError) return json({ error: { code: "INVALID_INPUT" } }, 400);
    console.error("Experience publication suspension failed", { error: error instanceof Error ? error.name : typeof error });
    return json({ error: { code: "STORE_UNAVAILABLE" } }, 503);
  }
}
