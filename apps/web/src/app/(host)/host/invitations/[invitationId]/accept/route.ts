import { type NextRequest } from "next/server";
import { StoreAccessDeniedError, StoreConflictError } from "@niho-experience/experience-store";
import { productOperatorRepository } from "@/lib/experience/store-server";
import { clearOperatorInvitationCookie, decodeOperatorInvitationCookie, OPERATOR_INVITATION_COOKIE } from "@/lib/host/operator-invitation-cookie";
import { mutationFromSameOrigin } from "@/lib/host/relay";
import { invitationIdOrNull, withProvider } from "@/lib/host/routes";
import { hostNotFound, loadHostProviders, noStoreJson, readHostSession, siteOrigin } from "@/lib/host/server";
import { idTokenUsable } from "@/lib/host/session";
import { config } from "@/lib/config";

export const runtime = "nodejs";

export async function POST(request: NextRequest, { params }: { params: Promise<{ invitationId: string }> }) {
  if (!config.hostConsoleEnabled || config.apiMode !== "http") return hostNotFound();
  if (!mutationFromSameOrigin("POST", request.headers, siteOrigin())) return noStoreJson({ error: "cross_site_request" }, 403);
  if (request.headers.get("content-type")?.split(";", 1)[0] !== "application/json") return noStoreJson({ error: "invalid_content_type" }, 415);
  if (Number(request.headers.get("content-length") ?? 0) > 1024) return noStoreJson({ error: "payload_too_large" }, 413);
  try { const raw = await request.arrayBuffer(); if (raw.byteLength > 1024 || new TextDecoder().decode(raw).trim() !== "{}") return noStoreJson({ error: "invalid_input" }, 400); }
  catch { return noStoreJson({ error: "invalid_input" }, 400); }
  const invitationId = invitationIdOrNull((await params).invitationId);
  if (!invitationId) return noStoreJson({ error: "not_found" }, 404);
  const prepared = decodeOperatorInvitationCookie(request.cookies.get(OPERATOR_INVITATION_COOKIE)?.value);
  if (!prepared || prepared.invitationId !== invitationId) return noStoreJson({ error: "invalid_invitation_session" }, 403);
  const session = await readHostSession();
  if (!session || !idTokenUsable(session, Date.now())) return noStoreJson({ error: "unauthenticated" }, 401);
  const identity = await loadHostProviders();
  if (identity.status !== "ok") return noStoreJson({ error: identity.status === "error" ? "identity_unavailable" : "unauthenticated" }, identity.status === "error" ? 503 : 401);
  const repository = productOperatorRepository();
  if (!repository) return noStoreJson({ error: "unavailable" }, 503);
  try {
    const grant = await repository.accept(invitationId, prepared.token, session.nihoUserId);
    const response = noStoreJson({ href: withProvider("/host/calendar", grant.providerId) });
    clearOperatorInvitationCookie(response);
    return response;
  } catch (error) {
    if (error instanceof StoreConflictError) return noStoreJson({ error: "already_accepted" }, 409);
    if (error instanceof StoreAccessDeniedError) return noStoreJson({ error: "invalid_invitation" }, 403);
    return noStoreJson({ error: "unavailable" }, 503);
  }
}
