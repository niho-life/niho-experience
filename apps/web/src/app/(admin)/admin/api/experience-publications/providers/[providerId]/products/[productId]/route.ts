import { NextResponse } from "next/server";
import { StoreValidationError } from "@niho-experience/experience-store";
import { clearAdminHttpSessionCookie, loadAdminHttpSession } from "@/lib/admin/server";
import { config } from "@/lib/config";
import { experiencePublicationRepository } from "@/lib/experience/store-server";

type Context = { params: Promise<{ providerId: string; productId: string }> };
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/;
const HEADERS = { "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-robots-tag": "noindex, nofollow" };
function json(body: unknown, status = 200): NextResponse { return NextResponse.json(body, { status, headers: HEADERS }); }

/**
 * A product's publication state, for the office (運営の CLI, #576): the version a suspension or its lifting must name. Unlike
 * the draft workspace API it also answers for a published product. Only the state's flags and times: no draft, price or seller.
 */
export async function GET(request: Request, context: Context): Promise<NextResponse> {
  if (!config.experiencePublicationsEnabled || config.apiMode !== "http" || !config.adminSupportConsoleEnabled) return json({ error: { code: "NOT_FOUND" } }, 404);
  const { providerId, productId } = await context.params;
  if (!ID.test(providerId) || !ID.test(productId) || new URL(request.url).search) return json({ error: { code: "INVALID_INPUT" } }, 400);
  const session = await loadAdminHttpSession();
  if (session.status !== "ok") {
    const response = json({ error: { code: session.status === "error" ? "READINESS_UNAVAILABLE" : session.status === "refresh" ? "SESSION_REFRESH_REQUIRED" : "SESSION_ENDED" } }, session.status === "error" ? 503 : 401);
    if (session.status === "rejected") clearAdminHttpSessionCookie(response);
    return response;
  }
  const repository = experiencePublicationRepository();
  if (!repository) return json({ error: { code: "STORE_UNAVAILABLE" } }, 503);
  try {
    const state = await repository.getStateForOperations({ nihoUserId: session.actor.id }, providerId, productId);
    if (!state) return json({ error: { code: "NOT_FOUND" } }, 404);
    return json({ publication: {
      stateVersion: state.version, published: state.currentPublicationId !== null, firstPublishedAtUtc: state.firstPublishedAtUtc,
      selfStoppedAtUtc: state.selfStoppedAtUtc, operationsSuspended: state.operationsSuspendedAtUtc !== null,
      operationsSuspensionCode: state.operationsSuspensionCode, ownerResumeRequired: state.ownerResumeRequired, updatedAtUtc: state.updatedAtUtc,
    } });
  } catch (error) {
    if (error instanceof StoreValidationError) return json({ error: { code: "INVALID_INPUT" } }, 400);
    console.error("Experience publication state read failed", { error: error instanceof Error ? error.name : typeof error });
    return json({ error: { code: "STORE_UNAVAILABLE" } }, 503);
  }
}
