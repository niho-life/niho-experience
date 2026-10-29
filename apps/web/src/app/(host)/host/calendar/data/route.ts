import type { NextRequest } from "next/server";
import { DomainValidationError, assertLocalDate, expandOccurrences, localDateDistance, parseScheduleRule, type ScheduleRule } from "@niho-experience/experience-domain";
import { StoreAccessDeniedError, StoreConflictError, StoreNotFoundError, StoreValidationError } from "@niho-experience/experience-store";
import type { HostCalendarData } from "@/experience/calendar-contract";
import { readHostCalendar } from "@/lib/experience/calendar-read";
import { syncGoogleBusy } from "@/lib/experience/google-connection";
import { experiencePool, experienceStore } from "@/lib/experience/store-server";
import { hostActor } from "@/lib/experience/host-actor";
import { mutationFromSameOrigin } from "@/lib/host/relay";
import { hostNotFound, isHostMock, noStoreJson, siteOrigin } from "@/lib/host/server";
import { config } from "@/lib/config";

export const runtime = "nodejs";
const MAX_BODY_BYTES = 16 * 1024;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function failure(error: unknown): Response {
  if (error instanceof StoreAccessDeniedError) return noStoreJson({ error: "forbidden" }, 403);
  if (error instanceof StoreNotFoundError) return noStoreJson({ error: "not_found" }, 404);
  if (error instanceof StoreConflictError) return noStoreJson({ error: "conflict" }, 409);
  if (error instanceof StoreValidationError || error instanceof DomainValidationError || error instanceof RangeError || error instanceof URIError) return noStoreJson({ error: "invalid_input" }, 400);
  return noStoreJson({ error: "calendar_unavailable" }, 503);
}

function preview(providerId: string, fromDate: string, toDate: string): HostCalendarData {
  const rule: ScheduleRule = {
    id: `preview-${providerId}`, timeZone: "Asia/Tokyo", startsOn: fromDate, localStartTime: "10:00", durationMinutes: 90,
    capacity: 4, bookingCutoffMinutes: 120, busyBufferBeforeMinutes: 0, busyBufferAfterMinutes: 0, recurrence: { kind: "WEEKLY" },
  };
  const occurrences = expandOccurrences({ rule, fromDate, toDate }).map((item) => ({ ...item, experienceId: "synthetic-experience", experienceTitle: "合成データの体験", availableSeats: 4, availabilityReason: "AVAILABLE" as const }));
  return { preview: true, canEdit: false, experiences: [{ id: "synthetic-experience", title: "合成データの体験" }], rules: [{ ...rule, experienceId: "synthetic-experience" }], occurrences: occurrences.map((item) => ({ ...item, confirmedSeats: 0, heldSeats: 0 })), busyIntervals: [], google: { connected: false, canManage: false, blockingEnabled: false, syncStatus: "STALE" } };
}

export async function GET(request: NextRequest) {
  if (!config.hostConsoleEnabled) return hostNotFound();
  const fromDate = request.nextUrl.searchParams.get("fromDate");
  const toDate = request.nextUrl.searchParams.get("toDate");
  try {
    assertLocalDate(fromDate, "fromDate");
    assertLocalDate(toDate, "toDate");
    if (localDateDistance(fromDate, toDate) < 0 || localDateDistance(fromDate, toDate) > 89) return noStoreJson({ error: "invalid_range" }, 400);
    const result = await hostActor(request.nextUrl.searchParams.get("providerId"));
    if ("response" in result) return result.response;
    if (isHostMock()) return noStoreJson(preview(result.actor.providerId, fromDate, toDate));
    const pool = experiencePool();
    const store = experienceStore();
    if (!pool || !store) return noStoreJson({ error: "calendar_not_configured" }, 503);
    const google = await store.getGoogleCalendar(result.actor);
    if (google && google.blockingEnabled && (google.syncStatus !== "FRESH" || !google.freshUntilUtc || google.freshUntilUtc <= new Date().toISOString())) {
      try { await syncGoogleBusy(pool, store, result.actor.providerId); } catch { /* The store marks this provider failed; availability stays closed. */ }
    }
    const data = await readHostCalendar(pool, store, result.actor, fromDate, toDate);
    const nihoCanEdit = result.nihoRole === "OWNER" || result.nihoRole === "EDITOR";
    return noStoreJson({ ...data, canEdit: data.canEdit && nihoCanEdit, google: { ...data.google, canManage: data.google.canManage && result.nihoRole === "OWNER" } });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: NextRequest) {
  if (!config.hostConsoleEnabled) return hostNotFound();
  if (!mutationFromSameOrigin("POST", request.headers, siteOrigin())) return noStoreJson({ error: "cross_site_request" }, 403);
  if (!request.headers.get("content-type")?.startsWith("application/json")) return noStoreJson({ error: "invalid_content_type" }, 415);
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return noStoreJson({ error: "payload_too_large" }, 413);
  const bodyBytes = await request.arrayBuffer();
  if (bodyBytes.byteLength > MAX_BODY_BYTES) return noStoreJson({ error: "payload_too_large" }, 413);
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bodyBytes));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return noStoreJson({ error: "invalid_body" }, 400);
    body = parsed as Record<string, unknown>;
  } catch { return noStoreJson({ error: "invalid_body" }, 400); }

  const result = await hostActor(body.providerId);
  if ("response" in result) return result.response;
  if (result.nihoRole !== "OWNER" && result.nihoRole !== "EDITOR") return noStoreJson({ error: "forbidden" }, 403);
  if (isHostMock()) return noStoreJson({ error: "preview_read_only" }, 403);
  const pool = experiencePool();
  const store = experienceStore();
  if (!pool || !store) return noStoreJson({ error: "calendar_not_configured" }, 503);
  try {
    if (typeof body.commandId !== "string" || !UUID_V4.test(body.commandId)) return noStoreJson({ error: "invalid_command_id" }, 400);
    if (body.action === "createRule") {
      if (typeof body.experienceId !== "string" || !body.rule || typeof body.rule !== "object" || Array.isArray(body.rule)) return noStoreJson({ error: "invalid_body" }, 400);
      const rule = parseScheduleRule({ ...body.rule, id: body.commandId });
      const saved = await store.saveScheduleRule(result.actor, body.experienceId, rule, null, body.commandId);
      return noStoreJson({ id: saved.aggregateId, version: saved.version }, saved.repeated ? 200 : 201);
    }
    if (body.action === "setSalesState" || body.action === "rescheduleOccurrence") {
      if (typeof body.occurrenceId !== "string" || body.occurrenceId.length > 256) return noStoreJson({ error: "invalid_body" }, 400);
      if (body.expectedVersion !== null && (!Number.isSafeInteger(body.expectedVersion) || (body.expectedVersion as number) < 1)) return noStoreJson({ error: "invalid_body" }, 400);
      if (body.action === "rescheduleOccurrence" && (typeof body.localDate !== "string" || typeof body.localStartTime !== "string")) return noStoreJson({ error: "invalid_body" }, 400);
      const separator = body.occurrenceId.lastIndexOf("@");
      if (separator < 1) return noStoreJson({ error: "invalid_body" }, 400);
      const ruleId = decodeURIComponent(body.occurrenceId.slice(0, separator));
      const rule = await pool.query<{ product_id: string }>(
        `SELECT r.product_id FROM schedule_rules r WHERE r.provider_id=$1 AND r.id=$3
          AND EXISTS (SELECT 1 FROM provider_memberships m WHERE m.provider_id=r.provider_id AND m.niho_user_id=$2 AND m.active=true AND m.role IN ('OWNER','EDITOR'))`,
        [result.actor.providerId, result.actor.nihoUserId, ruleId],
      );
      if (!rule.rows[0]) return noStoreJson({ error: "not_found" }, 404);
      if (body.action === "setSalesState") {
        if (body.desiredState !== "OPEN" && body.desiredState !== "CLOSED") return noStoreJson({ error: "invalid_body" }, 400);
        const saved = await store.setOccurrenceSalesState(
          result.actor,
          rule.rows[0].product_id,
          ruleId,
          { occurrenceId: body.occurrenceId, desiredState: body.desiredState },
          body.expectedVersion as number | null,
          body.commandId,
        );
        return noStoreJson({ occurrenceId: saved.aggregateId, version: saved.version });
      }
      const saved = await store.saveOccurrenceOverride(
        result.actor,
        rule.rows[0].product_id,
        ruleId,
        { kind: "RESCHEDULE", occurrenceId: body.occurrenceId, localDate: body.localDate as string, localStartTime: body.localStartTime as string },
        body.expectedVersion as number | null,
        body.commandId,
      );
      return noStoreJson({ occurrenceId: saved.aggregateId, version: saved.version });
    }
    return noStoreJson({ error: "invalid_action" }, 400);
  } catch (error) {
    return failure(error);
  }
}
