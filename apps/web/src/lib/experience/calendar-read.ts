import "server-only";
import type { Pool } from "pg";
import { addLocalDays, evaluateAvailability, expandOccurrences, tokyoLocalToUtc, type BusyInterval } from "@niho-experience/experience-domain";
import { ExperienceStore, StoreAccessDeniedError, type HostActor } from "@niho-experience/experience-store";
import type { HostCalendarData } from "@/experience/calendar-contract";

/** A private host read model. Mutations and booking decisions remain in ExperienceStore. */
export async function readHostCalendar(pool: Pool, store: ExperienceStore, actor: HostActor, fromDate: string, toDate: string): Promise<HostCalendarData> {
  const membership = await store.verifyActiveMembership(actor);
  if (!membership) throw new StoreAccessDeniedError();
  const products = await pool.query<{ id: string; public_title: string }>(
    `SELECT p.id, p.public_title FROM experience_products p
      WHERE p.provider_id=$1 AND p.status<>'ARCHIVED'
        AND EXISTS (SELECT 1 FROM provider_memberships m WHERE m.provider_id=p.provider_id AND m.niho_user_id=$2 AND m.active=true)
      ORDER BY p.public_title, p.id LIMIT 200`,
    [actor.providerId, actor.nihoUserId],
  );
  const schedule = await Promise.all(products.rows.map(async (product) => ({ product, views: await store.listSchedule(actor, product.id) })));
  const rules = schedule.flatMap(({ product, views }) => views.map((view) => ({ ...view.rule.rule, experienceId: product.id })));
  const expanded = schedule.flatMap(({ product, views }) => views.flatMap((view) =>
    expandOccurrences({ rule: view.rule.rule, overrides: view.overrides.map((entry) => entry.override), fromDate, toDate })
      .map((occurrence) => ({ occurrence, experienceId: product.id, experienceTitle: product.public_title })),
  ));
  if (expanded.length > 2_000) throw new RangeError("Too many occurrences in the requested range");

  const google = await store.getGoogleCalendar(actor);
  const nowUtc = new Date().toISOString();
  const syncStatus = google?.syncStatus === "FRESH" && google.freshUntilUtc && google.freshUntilUtc > nowUtc ? "FRESH" : google?.syncStatus === "FAILED" ? "FAILED" : "STALE";
  const fromUtc = tokyoLocalToUtc(fromDate, "00:00");
  const untilUtc = tokyoLocalToUtc(addLocalDays(toDate, 1), "00:00");
  const busyResult = google ? await pool.query<{ start_at: Date; end_at: Date }>(
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
       FROM bookings b WHERE b.provider_id=$1 AND b.occurrence_id=ANY($3::text[])
         AND EXISTS (SELECT 1 FROM provider_memberships m WHERE m.provider_id=b.provider_id AND m.niho_user_id=$2 AND m.active=true)
       GROUP BY b.occurrence_id`,
    [actor.providerId, actor.nihoUserId, occurrenceIds],
  ) : { rows: [] };
  const seatsByOccurrence = new Map(seats.rows.map((row) => [row.occurrence_id, { confirmed: Number(row.confirmed_seats), held: Number(row.held_seats) }]));
  const occurrences = expanded.map(({ occurrence, experienceId, experienceTitle }) => {
    const reserved = seatsByOccurrence.get(occurrence.id) ?? { confirmed: 0, held: 0 };
    const result = evaluateAvailability({ occurrence, requestedSeats: 1, confirmedSeats: reserved.confirmed, heldSeats: reserved.held, nowUtc,
      googleCalendar: { blockingEnabled: google?.blockingEnabled ?? false, syncStatus, busyIntervals } });
    return { ...occurrence, experienceId, experienceTitle, availableSeats: result.availableSeats, availabilityReason: result.reason };
  }).sort((a, b) => a.startUtc.localeCompare(b.startUtc));

  return {
    preview: false,
    experiences: products.rows.map((product) => ({ id: product.id, title: product.public_title })),
    rules, occurrences, busyIntervals,
    google: { connected: google !== null, canManage: membership.role === "OWNER", blockingEnabled: google?.blockingEnabled ?? false, syncStatus },
  };
}
