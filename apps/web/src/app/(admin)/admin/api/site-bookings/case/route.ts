import { StoreConflictError, StoreNotFoundError, StoreValidationError } from "@niho-experience/experience-store";
import { config } from "@/lib/config";
import { adminJson, adminMutationAllowed, isAdminHttp, loadAdminHttpSession } from "@/lib/admin/server";
import { adminSupportCaseApiClient, adminSupportCaseFailureJson } from "@/lib/admin/case-server";
import { experienceSupportRepository } from "@/lib/experience/store-server";
import { readBoundedJson } from "@/lib/read-bounded-json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const enabled = () => config.guestBookingEnabled && isAdminHttp();

function failed(error: unknown): Response {
  if (error instanceof StoreConflictError) return adminJson({ error: "conflict" }, 409);
  if (error instanceof StoreNotFoundError) return adminJson({ error: "not_found" }, 404);
  if (error instanceof StoreValidationError) return adminJson({ error: "invalid_input" }, 400);
  console.error("Experience support case failed", { error: error instanceof Error ? error.name : typeof error });
  return adminJson({ error: "unavailable" }, 503);
}

export async function GET(request: Request) {
  if (!enabled()) return adminJson({ error: "not_found" }, 404);
  const url = new URL(request.url);
  const publicBookingId = url.searchParams.get("publicBookingId");
  if (url.searchParams.size !== 1 || !publicBookingId || !UUID.test(publicBookingId)) return adminJson({ error: "invalid_input" }, 400);
  const session = await loadAdminHttpSession();
  if (session.status !== "ok") return adminJson({ error: session.status === "error" ? "unavailable" : "unauthenticated" }, session.status === "error" ? 503 : 401);
  const repository = experienceSupportRepository();
  if (!repository) return adminJson({ error: "unavailable" }, 503);
  try {
    return adminJson({ case: await repository.getCase({ nihoUserId: session.actor.id }, publicBookingId), currentAdminUserId: session.actor.id });
  } catch (error) {
    return failed(error);
  }
}

export async function POST(request: Request) {
  if (!enabled()) return adminJson({ error: "not_found" }, 404);
  if (!adminMutationAllowed(request) || request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") return adminJson({ error: "forbidden" }, 403);
  const session = await loadAdminHttpSession();
  if (session.status !== "ok") return adminJson({ error: session.status === "error" ? "unavailable" : "unauthenticated" }, session.status === "error" ? 503 : 401);
  let parsed: unknown;
  try { parsed = await readBoundedJson(request, 8 * 1024, { fatalUtf8: true }); }
  catch { return adminJson({ error: "invalid_input" }, 400); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return adminJson({ error: "invalid_input" }, 400);
  const body = parsed as Record<string, unknown>;
  if (Object.keys(body).some((key) => !["publicBookingId", "commandId", "expectedRevision", "assignedAdminUserId", "internalMemo"].includes(key))) return adminJson({ error: "invalid_input" }, 400);
  if (typeof body.publicBookingId !== "string" || !UUID.test(body.publicBookingId) || typeof body.commandId !== "string" || !UUID.test(body.commandId)
    || !Number.isSafeInteger(body.expectedRevision) || (body.assignedAdminUserId !== null && body.assignedAdminUserId !== "SELF" && typeof body.assignedAdminUserId !== "string")
    || (body.internalMemo !== null && typeof body.internalMemo !== "string")) return adminJson({ error: "invalid_input" }, 400);
  const repository = experienceSupportRepository();
  if (!repository) return adminJson({ error: "unavailable" }, 503);
  const actor = { nihoUserId: session.actor.id };
  try {
    const assignedAdminUserId = body.assignedAdminUserId === "SELF" ? actor.nihoUserId : body.assignedAdminUserId as string | null;
    if (assignedAdminUserId !== null && assignedAdminUserId !== actor.nihoUserId) {
      const current = await repository.getCase(actor, body.publicBookingId);
      if (current?.assignedAdminUserId !== assignedAdminUserId) {
        // The other admins are NIHO's list, read with the NIHO admin token: with the Google login (ADR 0003) a case is
        // assigned to oneself only.
        if (session.kind !== "niho") return adminJson({ error: "assignee_unavailable" }, 409);
        const candidates = await adminSupportCaseApiClient(session.session.idToken).listSupportAdmins();
        if (!candidates.ok) return adminSupportCaseFailureJson(candidates);
        if (!candidates.data.admins.some((admin) => admin.id === assignedAdminUserId)) return adminJson({ error: "assignee_unavailable" }, 409);
      }
    }
    const saved = await repository.updateCase(actor, body.publicBookingId, {
      commandId: body.commandId,
      expectedRevision: body.expectedRevision as number,
      assignedAdminUserId,
      internalMemo: body.internalMemo as string | null,
    });
    return adminJson({ case: saved, currentAdminUserId: actor.nihoUserId });
  } catch (error) {
    return failed(error);
  }
}
