import "server-only";
import type { Pool } from "pg";
import { addLocalDays, expandOccurrences, tokyoLocalToUtc, type BusyInterval } from "@niho-experience/experience-domain";
import { evaluateStoredInventories, ExperienceStore, StoreAccessDeniedError, type HostActor } from "@niho-experience/experience-store";
import type { HostCalendarData } from "@/experience/calendar-contract";

/** A private host read model. Mutations and booking decisions remain in ExperienceStore. */
export async function readHostCalendar(pool: Pool, store: ExperienceStore, actor: HostActor, fromDate: string, toDate: string): Promise<HostCalendarData> {
  const products = await store.listCalendarProducts(actor);
  const scope = actor.calendarScope === "OPERATOR" || products.some((product) => product.access.basis === "OPERATOR") ? "OPERATOR" : "MEMBER";
  if (scope === "OPERATOR" && products.length === 0) throw new StoreAccessDeniedError();
  const membership = scope === "MEMBER" ? await store.verifyActiveMembership(actor) : null;
  if (scope === "MEMBER" && !membership) throw new StoreAccessDeniedError();
  const schedule = await Promise.all(products.map(async (product) => ({ product, views: await store.listSchedule(actor, product.id) })));
  const rules = schedule.flatMap(({ product, views }) => views.map((view) => ({ ...view.rule.rule, experienceId: product.id })));
  const expanded = schedule.flatMap(({ product, views }) => views.flatMap((view) => {
    const overrideVersions = new Map(view.overrides.map((entry) => [entry.override.occurrenceId, entry.version]));
    const salesStateVersions = new Map(view.salesStates.map((entry) => [entry.state.occurrenceId, entry.version]));
    return expandOccurrences({
      rule: view.rule.rule,
      overrides: view.overrides.map((entry) => entry.override),
      salesStates: view.salesStates.map((entry) => entry.state),
      fromDate,
      toDate,
    }).map((occurrence) => ({
      occurrence,
      experienceId: product.id,
      experienceTitle: product.publicTitle,
      overrideVersion: overrideVersions.get(occurrence.id),
      salesStateVersion: salesStateVersions.get(occurrence.id),
    }));
  }));
  if (expanded.length > 2_000) throw new RangeError("Too many occurrences in the requested range");

  const google = scope === "MEMBER" ? await store.getGoogleCalendar(actor) : null;
  const nowUtc = new Date().toISOString();
  const fromUtc = tokyoLocalToUtc(fromDate, "00:00");
  const untilUtc = tokyoLocalToUtc(addLocalDays(toDate, 1), "00:00");
  const fresh = google?.syncStatus === "FRESH" && google.freshUntilUtc && google.freshUntilUtc > nowUtc;
  const covered = google?.coverageStartUtc !== undefined && google.coverageEndUtc !== undefined
    && google.coverageStartUtc <= fromUtc && google.coverageEndUtc >= untilUtc;
  const syncStatus = google?.syncStatus === "FAILED" ? "FAILED" : fresh && covered ? "FRESH" : "STALE";
  const busyResult = scope === "MEMBER" && google ? await pool.query<{ start_at: Date; end_at: Date }>(
    `SELECT b.start_at, b.end_at FROM google_busy_intervals b
      WHERE b.provider_id=$1 AND b.opaque_calendar_id=$3 AND b.end_at>$4 AND b.start_at<$5
        AND EXISTS (SELECT 1 FROM provider_memberships m WHERE m.provider_id=b.provider_id AND m.niho_user_id=$2 AND m.active=true)
      ORDER BY b.start_at LIMIT 5000`,
    [actor.providerId, actor.nihoUserId, google.opaqueCalendarId, fromUtc, untilUtc],
  ) : { rows: [] };
  const busyIntervals: BusyInterval[] = busyResult.rows.map((row) => ({ startUtc: row.start_at.toISOString(), endUtc: row.end_at.toISOString() }));

  const occurrenceIds = expanded.map(({ occurrence }) => occurrence.id);
  const seats = occurrenceIds.length ? await pool.query<{ occurrence_id: string; confirmed_seats: string; held_seats: string }>(
    `SELECT b.occurrence_id,
       COALESCE(sum(b.seats) FILTER (WHERE b.status='CONFIRMED'),0)::text AS confirmed_seats,
       COALESCE(sum(b.seats) FILTER (WHERE b.status='HOLD' AND b.hold_expires_at>clock_timestamp()),0)::text AS held_seats
       FROM bookings b WHERE b.provider_id=$1 AND b.occurrence_id=ANY($2::text[])
       GROUP BY b.occurrence_id`,
    [actor.providerId, occurrenceIds],
  ) : { rows: [] };
  const seatsByOccurrence = new Map(seats.rows.map((row) => [row.occurrence_id, { confirmed: Number(row.confirmed_seats), held: Number(row.held_seats) }]));
  const inventoryByOccurrence = await evaluateStoredInventories(pool, actor.providerId, expanded.map(({ occurrence, experienceId }) => ({
    productId: experienceId, occurrence, requestedSeats: 1,
  })), nowUtc);
  const occurrences = expanded.map(({ occurrence, experienceId, experienceTitle, overrideVersion, salesStateVersion }) => {
    const reserved = seatsByOccurrence.get(occurrence.id) ?? { confirmed: 0, held: 0 };
    const result = inventoryByOccurrence.get(occurrence.id)?.availability;
    if (result === undefined) throw new Error("Inventory evaluation did not return a host calendar occurrence.");
    const common = {
      ...occurrence,
      experienceId,
      experienceTitle,
      ...(overrideVersion === undefined ? {} : { overrideVersion }),
      ...(salesStateVersion === undefined ? {} : { salesStateVersion }),
      availabilityReason: result.reason,
      canReschedule: reserved.confirmed === 0 && reserved.held === 0,
    };
    return scope === "MEMBER" ? { ...common, availableSeats: result.availableSeats, confirmedSeats: reserved.confirmed, heldSeats: reserved.held } : common;
  });
  occurrences.sort((a, b) => a.startUtc.localeCompare(b.startUtc));

  return {
    scope,
    preview: false,
    canEdit: scope === "OPERATOR" || membership?.role === "OWNER" || membership?.role === "EDITOR",
    experiences: products.map((product) => ({ id: product.id, title: product.publicTitle })),
    rules, occurrences, busyIntervals,
    google: scope === "OPERATOR"
      ? { connected: false, canManage: false, blockingEnabled: false, syncStatus: "STALE" }
      : { connected: google !== null, canManage: membership?.role === "OWNER", blockingEnabled: google?.blockingEnabled ?? false, syncStatus },
  };
}
