import { StoreAccessDeniedError, StoreConflictError, StoreNotFoundError, StoreValidationError } from "@niho-experience/experience-store";
import { config } from "@/lib/config";
import { adminJson, adminMutationAllowed, isAdminHttp, loadAdminHttpSession } from "@/lib/admin/server";
import { productOperatorRepository } from "@/lib/experience/store-server";

export const runtime = "nodejs";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function enabled() { return config.hostConsoleEnabled && isAdminHttp(); }
function failure(error: unknown) {
  if (error instanceof StoreConflictError) return adminJson({ error: "conflict" }, 409);
  if (error instanceof StoreNotFoundError) return adminJson({ error: "not_found" }, 404);
  if (error instanceof StoreValidationError) return adminJson({ error: "invalid_input" }, 400);
  if (error instanceof StoreAccessDeniedError) return adminJson({ error: "forbidden" }, 403);
  return adminJson({ error: "unavailable" }, 503);
}

export async function GET(request: Request) {
  if (!enabled()) return adminJson({ error: "not_found" }, 404);
  const loaded = await loadAdminHttpSession();
  if (loaded.status !== "ok") return adminJson({ error: loaded.status === "error" ? "unavailable" : "unauthenticated" }, loaded.status === "error" ? 503 : 401);
  const url = new URL(request.url);
  if ([...url.searchParams.keys()].some((key) => key !== "q")) return adminJson({ error: "invalid_input" }, 400);
  const repository = productOperatorRepository();
  if (!repository) return adminJson({ error: "unavailable" }, 503);
  try { return adminJson(await repository.adminSnapshot(url.searchParams.get("q") ?? "")); } catch (error) { return failure(error); }
}

export async function POST(request: Request) {
  if (!enabled()) return adminJson({ error: "not_found" }, 404);
  if (!adminMutationAllowed(request)) return adminJson({ error: "forbidden" }, 403);
  if (request.headers.get("content-type")?.split(";", 1)[0] !== "application/json") return adminJson({ error: "invalid_content_type" }, 415);
  const loaded = await loadAdminHttpSession();
  if (loaded.status !== "ok") return adminJson({ error: loaded.status === "error" ? "unavailable" : "unauthenticated" }, loaded.status === "error" ? 503 : 401);
  let body: Record<string, unknown>;
  try { const value: unknown = await request.json(); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(); body = value as Record<string, unknown>; } catch { return adminJson({ error: "invalid_input" }, 400); }
  const commandId = typeof body.commandId === "string" && UUID_V4.test(body.commandId) ? body.commandId : null;
  if (!commandId) return adminJson({ error: "invalid_command_id" }, 400);
  const repository = productOperatorRepository();
  if (!repository) return adminJson({ error: "unavailable" }, 503);
  const actor = { nihoUserId: loaded.verified.actor.id };
  try {
    if (body.action === "createInvitation" && typeof body.providerId === "string" && typeof body.productId === "string" && typeof body.assignmentLabel === "string") {
      const created = await repository.createInvitation(actor, { providerId: body.providerId, productId: body.productId, assignmentLabel: body.assignmentLabel }, commandId);
      const link = created.token ? `${new URL(`/host/invitations/${created.invitation.id}`, config.siteUrl).href}#${created.token}` : undefined;
      return adminJson({ invitation: created.invitation, repeated: created.repeated, ...(link ? { link } : {}) }, created.repeated ? 200 : 201);
    }
    if (body.action === "revokeInvitation" && typeof body.invitationId === "string" && Number.isSafeInteger(body.expectedRevision)) {
      return adminJson({ invitation: await repository.revokeInvitation(actor, body.invitationId, body.expectedRevision as number, commandId) });
    }
    if (body.action === "revokeGrant" && typeof body.providerId === "string" && typeof body.productId === "string" && typeof body.nihoUserId === "string" && Number.isSafeInteger(body.expectedVersion)) {
      return adminJson({ grant: await repository.revokeGrant(actor, body.providerId, body.productId, body.nihoUserId, body.expectedVersion as number, commandId) });
    }
    return adminJson({ error: "invalid_input" }, 400);
  } catch (error) { return failure(error); }
}
