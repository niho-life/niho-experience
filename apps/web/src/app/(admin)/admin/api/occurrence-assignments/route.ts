import { StoreConflictError, StoreNotFoundError, StoreValidationError } from "@niho-experience/experience-store";
import { adminJson, adminMutationAllowed, isAdminHttp, loadAdminHttpSession } from "@/lib/admin/server";
import { config } from "@/lib/config";
import { occurrenceAssignmentRepository } from "@/lib/experience/store-server";
import { readBoundedJson } from "@/lib/read-bounded-json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/*
 * 開催回の担当 (#535 v0), NIHO's office: the occurrences with no assignee, who said 行けません, and recording for someone
 * (対応する / 行けません / 外れた) or the agreed fee by hand. It never approves, charges or confirms a booking.
 */

const BODY_LIMIT = 4 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/;

function enabled(): boolean {
  return isAdminHttp() && config.occurrenceAssignmentEnabled && config.managedSalesEnabled;
}

function failure(error: unknown): Response {
  if (error instanceof StoreConflictError) return adminJson({ error: "conflict" }, 409);
  if (error instanceof StoreNotFoundError) return adminJson({ error: "not_found" }, 404);
  if (error instanceof StoreValidationError) return adminJson({ error: "invalid_input" }, 400);
  console.error("Occurrence assignment failed", { error: error instanceof Error ? error.name : typeof error });
  return adminJson({ error: "unavailable" }, 503);
}

async function boundary(request: Request, mutation: boolean) {
  if (!enabled() || (mutation && new URL(request.url).search)) return { ok: false as const, response: adminJson({ error: "not_found" }, 404) };
  const loaded = await loadAdminHttpSession();
  if (loaded.status !== "ok") return { ok: false as const, response: adminJson({ error: loaded.status === "error" ? "unavailable" : "unauthenticated" }, loaded.status === "error" ? 503 : 401) };
  if (mutation && !adminMutationAllowed(request)) return { ok: false as const, response: adminJson({ error: "forbidden" }, 403) };
  const assignments = occurrenceAssignmentRepository();
  if (!assignments) return { ok: false as const, response: adminJson({ error: "unavailable" }, 503) };
  return { ok: true as const, actor: { nihoUserId: loaded.actor.id }, assignments };
}

/** No query: the list. `providerId` and `occurrenceId`: the candidates to record for and the whole history of that occurrence. */
export async function GET(request: Request): Promise<Response> {
  const current = await boundary(request, false); if (!current.ok) return current.response;
  const params = new URL(request.url).searchParams;
  try {
    if (params.size === 0) return adminJson({ rows: await current.assignments.adminList(current.actor) });
    const providerId = params.get("providerId"); const occurrenceId = params.get("occurrenceId");
    if (params.size !== 2 || !providerId || !occurrenceId || !ID.test(providerId) || !ID.test(occurrenceId)) return adminJson({ error: "invalid_input" }, 400);
    const input = { providerId, occurrenceId };
    const [candidates, history] = await Promise.all([current.assignments.adminCandidates(current.actor, input), current.assignments.adminHistory(current.actor, input)]);
    return adminJson({ candidates, history });
  } catch (error) { return failure(error); }
}

export async function POST(request: Request): Promise<Response> {
  const current = await boundary(request, true); if (!current.ok) return current.response;
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") return adminJson({ error: "invalid_input" }, 400);
  let body: Record<string, unknown>;
  try {
    const value = await readBoundedJson(request, BODY_LIMIT, { fatalUtf8: true });
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("shape");
    body = value as Record<string, unknown>;
  } catch { return adminJson({ error: "invalid_input" }, 400); }
  const allowed = ["action", "providerId", "occurrenceId", "commandId", "subjectNihoUserId", "reason", "agreedFeeYen"];
  if (Object.keys(body).some((key) => !allowed.includes(key))
    || typeof body.providerId !== "string" || !ID.test(body.providerId)
    || typeof body.occurrenceId !== "string" || !ID.test(body.occurrenceId)
    || typeof body.commandId !== "string" || !UUID.test(body.commandId)) {
    return adminJson({ error: "invalid_input" }, 400);
  }
  const base = { providerId: body.providerId, occurrenceId: body.occurrenceId, commandId: body.commandId };
  try {
    if (body.action === "SET_FEE") {
      if (body.agreedFeeYen !== null && typeof body.agreedFeeYen !== "number") return adminJson({ error: "invalid_input" }, 400);
      return adminJson(await current.assignments.adminSetAgreedFee(current.actor, { ...base, agreedFeeYen: body.agreedFeeYen as number | null }));
    }
    if (body.action !== "CLAIM" && body.action !== "DECLINE" && body.action !== "RELEASE") return adminJson({ error: "invalid_input" }, 400);
    if (body.reason !== undefined && body.reason !== null && typeof body.reason !== "string") return adminJson({ error: "invalid_input" }, 400);
    if (body.action !== "RELEASE" && (typeof body.subjectNihoUserId !== "string" || !ID.test(body.subjectNihoUserId))) return adminJson({ error: "invalid_input" }, 400);
    const result = await current.assignments.adminRecord(current.actor, {
      ...base, action: body.action, reason: body.reason as string | null | undefined,
      ...(typeof body.subjectNihoUserId === "string" ? { subjectNihoUserId: body.subjectNihoUserId } : {}),
    });
    // 担当済み is the answer to a claim that lost the race: the office must read the list again.
    return result.outcome === "TAKEN" ? adminJson({ error: "already_assigned", ...result }, 409) : adminJson(result);
  } catch (error) { return failure(error); }
}
