import {
  AGENT_PAYOUT_ADMIN_ACTIONS,
  StoreAccessDeniedError,
  StoreConflictError,
  StoreNotFoundError,
  StoreValidationError,
  type AgentPayoutAdminAction,
} from "@niho-experience/experience-store";
import { adminJson, adminMutationAllowed, isAdminHttp, loadAdminHttpSession } from "@/lib/admin/server";
import { config } from "@/lib/config";
import { agentPayoutRepository } from "@/lib/experience/store-server";
import { readBoundedJson } from "@/lib/read-bounded-json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/*
 * 代理受領の送金 (#725, 3b-2): the office's view and operations for one booking's payout. Gated by EXPERIENCE_HOST_AGENT_PAYOUTS_ENABLED (404 when
 * off), the Admin session, a same-origin JSON POST and the payout's (or adjustment's) version. The actor is left in the payout's events.
 */
type Context = { params: Promise<{ publicBookingId: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BODY_LIMIT = 8 * 1024;
const KEYS = ["action", "expectedVersion", "adjustmentId", "confirmedNotSent", "note"];

const enabled = (): boolean => isAdminHttp() && config.hostAgentPayoutsEnabled;

function failure(error: unknown): Response {
  if (error instanceof StoreConflictError) return adminJson({ error: "conflict" }, 409);
  if (error instanceof StoreNotFoundError) return adminJson({ error: "not_found" }, 404);
  if (error instanceof StoreValidationError) return adminJson({ error: "invalid_input" }, 400);
  if (error instanceof StoreAccessDeniedError) return adminJson({ error: "forbidden" }, 403);
  console.error("Agent payout operation failed", { error: error instanceof Error ? error.name : typeof error });
  return adminJson({ error: "unavailable" }, 503);
}

async function contextOf(context: Context) {
  if (!enabled()) return { ok: false as const, response: adminJson({ error: "not_found" }, 404) };
  const { publicBookingId } = await context.params;
  if (!UUID.test(publicBookingId)) return { ok: false as const, response: adminJson({ error: "invalid_input" }, 400) };
  const loaded = await loadAdminHttpSession();
  if (loaded.status !== "ok") return { ok: false as const, response: adminJson({ error: loaded.status === "error" ? "unavailable" : "unauthenticated" }, loaded.status === "error" ? 503 : 401) };
  const repository = agentPayoutRepository();
  if (!repository) return { ok: false as const, response: adminJson({ error: "unavailable" }, 503) };
  return { ok: true as const, publicBookingId: publicBookingId.toLowerCase(), adminId: loaded.actor.id, repository };
}

export async function GET(request: Request, context: Context): Promise<Response> {
  if (new URL(request.url).search) return adminJson({ error: "invalid_input" }, 400);
  const loaded = await contextOf(context); if (!loaded.ok) return loaded.response;
  try {
    const detail = await loaded.repository.getForBooking(loaded.publicBookingId);
    return detail ? adminJson({ detail }) : adminJson({ error: "not_found" }, 404);
  } catch (error) { return failure(error); }
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
  if (!Object.keys(body).every((key) => KEYS.includes(key))) return adminJson({ error: "invalid_input" }, 400);
  const { action, expectedVersion, adjustmentId, confirmedNotSent, note } = body;
  if (typeof action !== "string" || !(AGENT_PAYOUT_ADMIN_ACTIONS as readonly string[]).includes(action)
    || typeof expectedVersion !== "number" || !Number.isSafeInteger(expectedVersion)
    || (adjustmentId !== undefined && (typeof adjustmentId !== "string" || !UUID.test(adjustmentId)))
    || (confirmedNotSent !== undefined && typeof confirmedNotSent !== "boolean")
    || (note !== undefined && typeof note !== "string")) return adminJson({ error: "invalid_input" }, 400);
  try {
    const detail = await loaded.repository.adminAct(loaded.adminId, loaded.publicBookingId, {
      action: action as AgentPayoutAdminAction, expectedVersion, ...(adjustmentId === undefined ? {} : { adjustmentId: adjustmentId as string }),
      ...(confirmedNotSent === undefined ? {} : { confirmedNotSent }), ...(note === undefined ? {} : { note }),
    });
    return adminJson({ detail });
  } catch (error) { return failure(error); }
}
