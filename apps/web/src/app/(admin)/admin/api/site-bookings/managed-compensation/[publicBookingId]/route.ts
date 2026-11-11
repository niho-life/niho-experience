import {
  StoreAccessDeniedError,
  StoreConflictError,
  StoreNotFoundError,
  StoreValidationError,
} from "@niho-experience/experience-store";
import { adminJson, adminMutationAllowed, isAdminHttp, loadAdminHttpSession } from "@/lib/admin/server";
import { config } from "@/lib/config";
import { managedExperienceSalesRepository } from "@/lib/experience/store-server";
import { readBoundedJson } from "@/lib/read-bounded-json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ publicBookingId: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BODY_LIMIT = 8 * 1024;

function enabled(): boolean {
  // Settlement remains available while the platform still services accepted reservations.
  return isAdminHttp() && config.managedSalesWebhooksEnabled;
}

function failure(error: unknown): Response {
  if (error instanceof StoreConflictError) return adminJson({ error: "conflict" }, 409);
  if (error instanceof StoreNotFoundError) return adminJson({ error: "not_found" }, 404);
  if (error instanceof StoreValidationError) return adminJson({ error: "invalid_input" }, 400);
  if (error instanceof StoreAccessDeniedError) return adminJson({ error: "forbidden" }, 403);
  console.error("Managed compensation operation failed", { error: error instanceof Error ? error.name : typeof error });
  return adminJson({ error: "unavailable" }, 503);
}

async function contextOf(context: Context) {
  if (!enabled()) return { ok: false as const, response: adminJson({ error: "not_found" }, 404) };
  const { publicBookingId } = await context.params;
  if (!UUID.test(publicBookingId)) return { ok: false as const, response: adminJson({ error: "invalid_input" }, 400) };
  const loaded = await loadAdminHttpSession();
  if (loaded.status !== "ok") return { ok: false as const, response: adminJson({ error: loaded.status === "error" ? "unavailable" : "unauthenticated" }, loaded.status === "error" ? 503 : 401) };
  const repository = managedExperienceSalesRepository();
  if (!repository) return { ok: false as const, response: adminJson({ error: "unavailable" }, 503) };
  return { ok: true as const, publicBookingId, actor: { nihoUserId: loaded.actor.id }, repository };
}

export async function GET(request: Request, context: Context): Promise<Response> {
  if (new URL(request.url).search) return adminJson({ error: "invalid_input" }, 400);
  const loaded = await contextOf(context); if (!loaded.ok) return loaded.response;
  try { return adminJson({ compensation: await loaded.repository.getCompensation(loaded.publicBookingId) }); }
  catch (error) { return failure(error); }
}

export async function POST(request: Request, context: Context): Promise<Response> {
  if (!adminMutationAllowed(request)) return adminJson({ error: "forbidden" }, 403);
  if (new URL(request.url).search || request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") return adminJson({ error: "invalid_input" }, 400);
  const loaded = await contextOf(context); if (!loaded.ok) return loaded.response;
  let body: Record<string, unknown>;
  try {
    const value = await readBoundedJson(request, BODY_LIMIT);
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("shape");
    body = value as Record<string, unknown>;
  } catch { return adminJson({ error: "invalid_input" }, 400); }
  const commandId = body.commandId;
  if (typeof body.action !== "string" || typeof commandId !== "string" || !UUID_V4.test(commandId)) return adminJson({ error: "invalid_input" }, 400);
  try {
    if (body.action === "CALCULATE" && Object.keys(body).every((key) => ["action", "commandId"].includes(key))) {
      return adminJson({ compensation: await loaded.repository.calculateCompensation(loaded.actor, loaded.publicBookingId, commandId) });
    }
    if (typeof body.expectedVersion !== "number" || !Number.isSafeInteger(body.expectedVersion)) return adminJson({ error: "invalid_input" }, 400);
    if (body.action === "PREPARE" && Object.keys(body).every((key) => ["action", "commandId", "expectedVersion", "recipientVerified"].includes(key)) && body.recipientVerified === true) {
      return adminJson({ compensation: await loaded.repository.prepareCompensation(loaded.actor, loaded.publicBookingId, { commandId, expectedVersion: body.expectedVersion, recipientVerified: true }) });
    }
    if (body.action === "RESULT_UNKNOWN" && Object.keys(body).every((key) => ["action", "commandId", "expectedVersion"].includes(key))) {
      return adminJson({ compensation: await loaded.repository.markCompensationResultUnknown(loaded.actor, loaded.publicBookingId, { commandId, expectedVersion: body.expectedVersion }) });
    }
    if (body.action === "RECONCILE_PAID" && Object.keys(body).every((key) => ["action", "commandId", "expectedVersion", "statementReference", "paidAtUtc", "paidAmount"].includes(key)) && typeof body.statementReference === "string" && typeof body.paidAtUtc === "string"
      && Date.parse(body.paidAtUtc) <= Date.now() && Number.isSafeInteger(body.paidAmount)) {
      return adminJson({ compensation: await loaded.repository.reconcileCompensation(loaded.actor, loaded.publicBookingId, { commandId, expectedVersion: body.expectedVersion, statementReference: body.statementReference, paidAtUtc: body.paidAtUtc, paidAmount: body.paidAmount as number }) });
    }
    if (body.action === "RECONCILE_NOT_PAID" && Object.keys(body).every((key) => ["action", "commandId", "expectedVersion", "statementReference"].includes(key))
      && typeof body.statementReference === "string") {
      return adminJson({ compensation: await loaded.repository.reconcileCompensationNotPaid(loaded.actor, loaded.publicBookingId, {
        commandId, expectedVersion: body.expectedVersion, statementReference: body.statementReference,
      }) });
    }
    return adminJson({ error: "invalid_input" }, 400);
  } catch (error) { return failure(error); }
}
