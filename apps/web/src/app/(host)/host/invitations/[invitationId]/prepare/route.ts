import { readBoundedJson, ResponseBodyTooLarge } from "@/lib/read-bounded-json";
import { NextResponse, type NextRequest } from "next/server";
import { StoreAccessDeniedError, StoreValidationError } from "@niho-experience/experience-store";
import { productOperatorRepository } from "@/lib/experience/store-server";
import { setOperatorInvitationCookie } from "@/lib/host/operator-invitation-cookie";
import { mutationFromSameOrigin } from "@/lib/host/relay";
import { invitationIdOrNull } from "@/lib/host/routes";
import { hostNotFound, noStoreJson, siteOrigin } from "@/lib/host/server";
import { config } from "@/lib/config";

export const runtime = "nodejs";
const MAX_BODY_BYTES = 2 * 1024;

export async function POST(request: NextRequest, { params }: { params: Promise<{ invitationId: string }> }) {
  if (!config.hostConsoleEnabled || config.apiMode !== "http") return hostNotFound();
  if (!mutationFromSameOrigin("POST", request.headers, siteOrigin())) return noStoreJson({ error: "cross_site_request" }, 403);
  if (request.headers.get("content-type")?.split(";", 1)[0] !== "application/json") return noStoreJson({ error: "invalid_content_type" }, 415);
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return noStoreJson({ error: "payload_too_large" }, 413);
  const invitationId = invitationIdOrNull((await params).invitationId);
  if (!invitationId) return noStoreJson({ error: "not_found" }, 404);
  let body: unknown;
  try { body = await readBoundedJson(request, MAX_BODY_BYTES, { fatalUtf8: true }); }
  catch (error) { return noStoreJson({ error: error instanceof ResponseBodyTooLarge ? "payload_too_large" : "invalid_input" }, error instanceof ResponseBodyTooLarge ? 413 : 400); }
  const token = body && typeof body === "object" && !Array.isArray(body) && Object.keys(body).length === 1 ? (body as { token?: unknown }).token : null;
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) return noStoreJson({ error: "invalid_input" }, 400);
  const repository = productOperatorRepository();
  if (!repository) return noStoreJson({ error: "unavailable" }, 503);
  try {
    const prepared = await repository.prepare(invitationId, token);
    const now = Date.now();
    const expiresAt = Math.min(Date.parse(prepared.expiresAtUtc), now + 10 * 60 * 1000);
    const response = NextResponse.json({ prepared: true }, { headers: { "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-robots-tag": "noindex, nofollow" } });
    setOperatorInvitationCookie(response, { invitationId, token, expiresAt }, now);
    return response;
  } catch (error) {
    if (error instanceof StoreAccessDeniedError) return noStoreJson({ error: "invalid_invitation" }, 403);
    if (error instanceof StoreValidationError) return noStoreJson({ error: "invalid_input" }, 400);
    return noStoreJson({ error: "unavailable" }, 503);
  }
}
