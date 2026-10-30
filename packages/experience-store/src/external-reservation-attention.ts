import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { isoValue, type DbRow } from "./rows.ts";

/**
 * Staff attention for external reservations (#200): a work queue for inventory
 * conflicts and the time from detecting a reservation until the product's other
 * listings are verified closed. Nothing here cancels, refunds, charges, or
 * contacts anyone, and nothing changes a reservation or inventory.
 */

export const MANUAL_CONFLICT_RESOLUTIONS = ["CUSTOMER_CONTACTED", "ACCEPTED_BOTH", "CANCELLED_AT_SOURCE"] as const;
export type ManualConflictResolution = typeof MANUAL_CONFLICT_RESOLUTIONS[number];
export type ConflictCaseResolution = "CONFLICT_CLEARED" | ManualConflictResolution;
export type PropagationStatus = "OPEN" | "COMPLETED" | "NOT_REQUIRED" | "ABANDONED" | "TIMED_OUT";

/** A measurement still open this long after detection is closed as TIMED_OUT. */
export const PROPAGATION_TIMEOUT_MS = 24 * 60 * 60_000;
export const ATTENTION_WINDOW_DAYS = 30;
const SETTLE_LIMIT = 500;
const MEMBER_LIMIT = 100;
const TARGET_LIMIT = 100;
const METRIC_ROW_LIMIT = 10_000;
const ACTIVE = "('PENDING','CONFIRMED')";

export interface ExternalReservationKey {
  readonly site: string;
  readonly externalAccountId: string;
  readonly externalReservationId: string;
}

export type ConflictPartner =
  | { readonly kind: "DIRECT"; readonly bookingId: string; readonly seats: number }
  | { readonly kind: "EXTERNAL"; readonly key: ExternalReservationKey; readonly localRevision: number; readonly seats: number };

export interface ConflictMemberView {
  readonly kind: "EXTERNAL" | "DIRECT";
  /** EXTERNAL only. The external account ID is never returned. */
  readonly site?: string;
  readonly externalReservationId?: string;
  /** DIRECT only: the experience booking ID. */
  readonly bookingId?: string;
  readonly seats: number;
  /** Current status. MOVED: the external reservation now points at another occurrence. */
  readonly status: string;
  readonly addedAtUtc: string;
}

export interface ConflictCaseView {
  readonly id: string;
  readonly productId: string;
  readonly productTitle: string;
  readonly occurrenceId: string;
  readonly occurrenceStartAtUtc?: string;
  readonly status: "OPEN" | "RESOLVED";
  readonly openedAtUtc: string;
  readonly lastSeenAtUtc: string;
  readonly acknowledged: boolean;
  readonly assignedToMe: boolean;
  readonly resolvedAtUtc?: string;
  readonly resolution?: ConflictCaseResolution;
  readonly members: readonly ConflictMemberView[];
}

export interface DurationSummary {
  readonly count: number;
  readonly p50Seconds?: number;
  readonly p95Seconds?: number;
}

export interface PropagationMetrics {
  readonly providerId: string;
  readonly generatedAtUtc: string;
  readonly fromUtc: string;
  readonly windowDays: number;
  /** True when more than the row limit fell in the window; figures then cover the newest rows only. */
  readonly truncated: boolean;
  readonly counts: Readonly<Record<PropagationStatus, number>>;
  readonly closeVerified: DurationSummary & { readonly maxSeconds?: number; readonly over60Minutes: number };
  readonly detectionLag: DurationSummary;
  readonly queueWait: DurationSummary;
  readonly bySite: readonly { readonly site: string; readonly count: number; readonly closeVerifiedP95Seconds?: number }[];
  readonly open: { readonly count: number; readonly oldestAgeSeconds?: number };
}

export interface OpenConflictCaseFinding {
  readonly caseId: string;
  readonly providerId: string;
  readonly externalMembers: number;
  readonly directMembers: number;
}

export interface AttentionSettlement {
  readonly openCases: readonly OpenConflictCaseFinding[];
  readonly casesTruncated: boolean;
  readonly casesCleared: number;
  readonly measurementsSettled: number;
}

async function addExternalMember(client: PoolClient, caseId: string, key: ExternalReservationKey, localRevision: number, seats: number, nowUtc: string): Promise<void> {
  await client.query(
    `INSERT INTO external_reservation_conflict_members AS m
      (case_id,member_kind,source_site,source_external_account_id,external_reservation_id,local_revision,occurrence_id,seats,added_at)
     SELECT $1::uuid,'EXTERNAL',e.source_site,e.source_external_account_id,e.external_reservation_id,$5,e.occurrence_id,$6,$7
       FROM external_reservations e
      WHERE e.source_site=$2 AND e.source_external_account_id=$3 AND e.external_reservation_id=$4
     ON CONFLICT (case_id,source_site,source_external_account_id,external_reservation_id) WHERE member_kind='EXTERNAL'
     DO UPDATE SET local_revision=EXCLUDED.local_revision,seats=EXCLUDED.seats WHERE m.local_revision<EXCLUDED.local_revision`,
    [caseId, key.site, key.externalAccountId, key.externalReservationId, localRevision, seats, nowUtc],
  );
}

/**
 * Called by the ledger, inside its provider-inventory transaction, after an
 * active reservation was written with an inventory conflict. Repeated calls for
 * the same occurrence reuse the open case and never duplicate members.
 */
export async function recordConflictCase(client: PoolClient, input: {
  readonly providerId: string;
  readonly productId: string;
  readonly occurrenceId: string;
  readonly nowUtc: string;
  readonly reservation: { readonly key: ExternalReservationKey; readonly localRevision: number; readonly seats: number };
  readonly partners: readonly ConflictPartner[];
}): Promise<string> {
  const upserted = await client.query<DbRow>(
    `INSERT INTO external_reservation_conflict_cases AS c
      (id,provider_id,product_id,occurrence_id,status,opened_at,last_seen_at,created_at,updated_at)
     VALUES ($1::uuid,$2,$3,$4,'OPEN',$5,$5,$5,$5)
     ON CONFLICT (provider_id,occurrence_id) WHERE status='OPEN'
     DO UPDATE SET last_seen_at=GREATEST(c.last_seen_at,EXCLUDED.last_seen_at),updated_at=EXCLUDED.updated_at
     RETURNING id::text`,
    [randomUUID(), input.providerId, input.productId, input.occurrenceId, input.nowUtc],
  );
  const caseId = String(upserted.rows[0]?.id);
  const { reservation, nowUtc } = input;
  await addExternalMember(client, caseId, reservation.key, reservation.localRevision, reservation.seats, nowUtc);
  await client.query(
    `INSERT INTO external_reservation_conflict_members (case_id,member_kind,booking_id,seats,added_at)
     SELECT $1::uuid,'DIRECT',b.id,b.seats,$4 FROM bookings b
      WHERE b.provider_id=$2 AND b.occurrence_id=$3 AND (b.status='CONFIRMED' OR (b.status='HOLD' AND b.hold_expires_at>$4))
      ORDER BY b.id LIMIT ${MEMBER_LIMIT}
     ON CONFLICT (case_id,booking_id) WHERE member_kind='DIRECT' DO NOTHING`,
    [caseId, input.providerId, input.occurrenceId, nowUtc],
  );
  const others = await client.query<DbRow>(
    `SELECT source_site,source_external_account_id,external_reservation_id,local_revision,seats FROM external_reservations
      WHERE provider_id=$1 AND occurrence_id=$2 AND status IN ${ACTIVE}
        AND NOT (source_site=$3 AND source_external_account_id=$4 AND external_reservation_id=$5)
      ORDER BY created_at,external_reservation_id LIMIT ${MEMBER_LIMIT}`,
    [input.providerId, input.occurrenceId, reservation.key.site, reservation.key.externalAccountId, reservation.key.externalReservationId],
  );
  for (const row of others.rows) {
    await addExternalMember(client, caseId, {
      site: String(row.source_site), externalAccountId: String(row.source_external_account_id), externalReservationId: String(row.external_reservation_id),
    }, Number(row.local_revision), Number(row.seats), nowUtc);
  }
  for (const partner of input.partners.slice(0, MEMBER_LIMIT)) {
    if (partner.kind === "EXTERNAL") {
      await addExternalMember(client, caseId, partner.key, partner.localRevision, partner.seats, nowUtc);
    } else {
      await client.query(
        `INSERT INTO external_reservation_conflict_members (case_id,member_kind,booking_id,seats,added_at)
         VALUES ($1::uuid,'DIRECT',$2::bigint,$3,$4) ON CONFLICT (case_id,booking_id) WHERE member_kind='DIRECT' DO NOTHING`,
        [caseId, partner.bookingId, partner.seats, nowUtc],
      );
    }
  }
  return caseId;
}

export interface PendingPropagationMeasurement {
  readonly providerId: string;
  readonly productId: string;
  readonly occurrenceId: string;
  readonly sourceListingId: string;
  readonly key: ExternalReservationKey;
  readonly localRevision: number;
  readonly sourceUpdatedAtUtc?: string;
  readonly detectedAtUtc: string;
}

/**
 * Records measurements after the ledger enqueued its calendar recalculation, so
 * the outbox watermark covers the event that reflects this reservation.
 */
export async function recordPropagationMeasurements(client: PoolClient, providerId: string, pending: readonly PendingPropagationMeasurement[]): Promise<void> {
  if (pending.length === 0) return;
  const watermark = await client.query<DbRow>("SELECT max(id)::text AS id FROM calendar_outbox_events WHERE provider_id=$1", [providerId]);
  const watermarkId = watermark.rows[0]?.id ?? null;
  for (const item of pending) {
    // Only the same product's other active listings. A different product sharing a resource is not measured.
    const targets = await client.query<DbRow>(
      `SELECT l.id,a.site FROM channel_listings l JOIN channel_external_accounts a ON a.id=l.account_id
        WHERE l.provider_id=$1 AND l.product_id=$2 AND l.active=true AND l.id<>$3
        ORDER BY l.id COLLATE "C" LIMIT ${TARGET_LIMIT}`,
      [item.providerId, item.productId, item.sourceListingId],
    );
    const open = targets.rows.length > 0 && watermarkId !== null;
    const id = randomUUID();
    const inserted = await client.query(
      `INSERT INTO channel_propagation_measurements
        (id,provider_id,product_id,occurrence_id,source_site,source_external_account_id,external_reservation_id,local_revision,
         source_updated_at,detected_at,outbox_watermark_id,status,target_count,completed_at,created_at,updated_at)
       VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::bigint,$12,$13,$14,$10,$10)
       ON CONFLICT (source_site,source_external_account_id,external_reservation_id,local_revision) DO NOTHING`,
      [id, item.providerId, item.productId, item.occurrenceId, item.key.site, item.key.externalAccountId, item.key.externalReservationId,
        item.localRevision, item.sourceUpdatedAtUtc ?? null, item.detectedAtUtc, open ? watermarkId : null,
        open ? "OPEN" : "NOT_REQUIRED", targets.rows.length, open ? null : item.detectedAtUtc],
    );
    if (inserted.rowCount === 0) continue;
    for (const target of targets.rows) {
      await client.query(
        "INSERT INTO channel_propagation_targets (measurement_id,listing_id,site,outcome) VALUES ($1::uuid,$2,$3,$4)",
        [id, String(target.id), String(target.site), open ? "PENDING" : "NOT_REQUIRED"],
      );
    }
  }
}

function sameVersion(row: DbRow, observed: string, current: string): boolean {
  return row[observed] !== null && row[observed] !== undefined && String(row[observed]) === String(row[current]);
}

/**
 * Runs inside the watchdog transaction under its advisory lock. It closes
 * cleared conflict cases, lists the open ones for incidents, and settles open
 * measurements. It never changes a reservation, booking, job, or inventory.
 */
export async function settleReservationAttention(client: PoolClient, now: Date): Promise<AttentionSettlement> {
  const nowUtc = now.toISOString();
  const cleared = await client.query(
    `UPDATE external_reservation_conflict_cases SET status='RESOLVED',resolution='CONFLICT_CLEARED',
       resolved_at=GREATEST($1::timestamptz,opened_at),updated_at=$1
      WHERE id IN (
        SELECT c.id FROM external_reservation_conflict_cases c
         WHERE c.status='OPEN' AND NOT EXISTS (
           SELECT 1 FROM external_reservations e
            WHERE e.provider_id=c.provider_id AND e.occurrence_id=c.occurrence_id AND e.status IN ${ACTIVE}
              AND e.needs_review=true AND e.review_reason='INVENTORY_CONFLICT')
         ORDER BY c.opened_at,c.id LIMIT ${SETTLE_LIMIT} FOR UPDATE OF c SKIP LOCKED)`,
    [nowUtc],
  );
  const open = await client.query<DbRow>(
    `SELECT c.id::text,c.provider_id,
            (SELECT count(*) FROM external_reservation_conflict_members m WHERE m.case_id=c.id AND m.member_kind='EXTERNAL')::int AS external_members,
            (SELECT count(*) FROM external_reservation_conflict_members m WHERE m.case_id=c.id AND m.member_kind='DIRECT')::int AS direct_members
       FROM external_reservation_conflict_cases c WHERE c.status='OPEN'
      ORDER BY c.opened_at,c.id LIMIT ${SETTLE_LIMIT}`,
  );

  const measurements = await client.query<DbRow>(
    `SELECT m.id::text,m.occurrence_id,m.detected_at,
            (e.status IN ${ACTIVE} AND e.occurrence_id=m.occurrence_id) AS still_active,
            -- Same "pending" as the outbox consumer: unprocessed and already available. A future-dated
            -- event (for example a scheduled freshness expiry) does not reflect this reservation.
            EXISTS (SELECT 1 FROM calendar_outbox_events o
                     WHERE o.provider_id=m.provider_id AND o.processed_at IS NULL AND o.available_at<=$1
                       AND o.id<=m.outbox_watermark_id) AS outbox_pending
       FROM channel_propagation_measurements m
       JOIN external_reservations e ON e.source_site=m.source_site
        AND e.source_external_account_id=m.source_external_account_id AND e.external_reservation_id=m.external_reservation_id
      WHERE m.status='OPEN' ORDER BY m.detected_at,m.id LIMIT ${SETTLE_LIMIT} FOR UPDATE OF m SKIP LOCKED`,
    [nowUtc],
  );
  let settled = 0;
  for (const measurement of measurements.rows) {
    const id = String(measurement.id);
    const detectedAtUtc = isoValue(measurement, "detected_at");
    const finish = async (status: Exclude<PropagationStatus, "OPEN" | "COMPLETED">) => {
      await client.query("UPDATE channel_propagation_targets SET outcome='UNVERIFIED' WHERE measurement_id=$1::uuid AND outcome='PENDING'", [id]);
      await client.query("UPDATE channel_propagation_measurements SET status=$2,completed_at=$3,updated_at=$3 WHERE id=$1::uuid", [id, status, nowUtc]);
      settled += 1;
    };
    if (measurement.still_active !== true) {
      await finish("ABANDONED");
      continue;
    }
    const targets = await client.query<DbRow>(
      `SELECT t.listing_id,d.desired_state,d.observed_state,d.desired_version,d.observed_desired_version,
              d.mapping_version,d.observed_mapping_version,d.last_verified_at
         FROM channel_propagation_targets t
         LEFT JOIN channel_desired_states d ON d.listing_id=t.listing_id AND d.occurrence_id=$2
        WHERE t.measurement_id=$1::uuid AND t.outcome='PENDING'`,
      [id, String(measurement.occurrence_id)],
    );
    for (const target of targets.rows) {
      if (target.desired_state === null || target.desired_state === undefined) continue;
      const synced = target.observed_state === target.desired_state
        && sameVersion(target, "observed_desired_version", "desired_version")
        && sameVersion(target, "observed_mapping_version", "mapping_version");
      const verifiedAtUtc = target.last_verified_at === null ? undefined : isoValue(target, "last_verified_at");
      if (target.desired_state === "CLOSED" && synced && verifiedAtUtc !== undefined && verifiedAtUtc >= detectedAtUtc) {
        const job = await client.query<DbRow>(
          `SELECT created_at,lease_started_at FROM channel_jobs
            WHERE listing_id=$1 AND occurrence_id=$2 AND action='SET_CLOSED' AND status='FINISHED' AND outcome='VERIFIED' AND updated_at>=$3
            ORDER BY updated_at DESC,created_at DESC LIMIT 1`,
          [String(target.listing_id), String(measurement.occurrence_id), detectedAtUtc],
        );
        const jobRow = job.rows[0];
        await client.query(
          `UPDATE channel_propagation_targets SET outcome='VERIFIED',verified_closed_at=$3,job_created_at=$4,job_claimed_at=$5
            WHERE measurement_id=$1::uuid AND listing_id=$2`,
          [id, String(target.listing_id), verifiedAtUtc, jobRow ? isoValue(jobRow, "created_at") : null,
            jobRow?.lease_started_at ? isoValue(jobRow, "lease_started_at") : null],
        );
        continue;
      }
      // With every calendar event up to this reservation processed, an OPEN desired
      // state means seats remain; an already verified CLOSED one needed no new write.
      if (measurement.outbox_pending === true) continue;
      if (target.desired_state === "OPEN" || (target.desired_state === "CLOSED" && synced && verifiedAtUtc !== undefined)) {
        await client.query(
          "UPDATE channel_propagation_targets SET outcome='NOT_REQUIRED' WHERE measurement_id=$1::uuid AND listing_id=$2",
          [id, String(target.listing_id)],
        );
      }
    }
    const summary = (await client.query<DbRow>(
      `SELECT count(*) FILTER (WHERE outcome='PENDING')::int AS pending,count(*) FILTER (WHERE outcome='VERIFIED')::int AS verified,
              max(verified_closed_at) AS closed_verified_at
         FROM channel_propagation_targets WHERE measurement_id=$1::uuid`, [id],
    )).rows[0]!;
    if (Number(summary.pending) === 0) {
      const verified = Number(summary.verified) > 0;
      await client.query(
        "UPDATE channel_propagation_measurements SET status=$2,closed_verified_at=$3,completed_at=$4,updated_at=$4 WHERE id=$1::uuid",
        [id, verified ? "COMPLETED" : "NOT_REQUIRED", verified ? isoValue(summary, "closed_verified_at") : null, nowUtc],
      );
      settled += 1;
    } else if (now.getTime() - Date.parse(detectedAtUtc) > PROPAGATION_TIMEOUT_MS) {
      await finish("TIMED_OUT");
    }
  }

  return {
    openCases: open.rows.map((row) => ({
      caseId: String(row.id), providerId: String(row.provider_id),
      externalMembers: Number(row.external_members), directMembers: Number(row.direct_members),
    })),
    casesTruncated: open.rows.length === SETTLE_LIMIT,
    casesCleared: cleared.rowCount ?? 0,
    measurementsSettled: settled,
  };
}

/** MOVED compares with the occurrence the reservation had when it joined the case, not with the case's own. */
function externalMemberStatus(row: DbRow): string {
  if (row.external_status === null || row.external_status === undefined) return "UNKNOWN";
  if (row.external_occurrence_id !== row.member_occurrence_id && String(row.external_status) !== "CANCELLED") return "MOVED";
  return String(row.external_status);
}

function directMemberStatus(row: DbRow, nowUtc: string): string {
  if (row.booking_status === null || row.booking_status === undefined) return "UNKNOWN";
  if (row.booking_status === "HOLD" && isoValue(row, "hold_expires_at") <= nowUtc) return "EXPIRED";
  return String(row.booking_status);
}

/** OPEN cases and those resolved in the last 30 days. No customer data exists to return; external account IDs are omitted. */
export async function loadConflictCases(db: Pool | PoolClient, providerId: string, viewerNihoUserId: string, now: Date): Promise<readonly ConflictCaseView[]> {
  const nowUtc = now.toISOString();
  const since = new Date(now.getTime() - ATTENTION_WINDOW_DAYS * 86_400_000).toISOString();
  const cases = await db.query<DbRow>(
    `SELECT c.id::text,c.product_id,c.occurrence_id,c.status,c.opened_at,c.last_seen_at,c.assignee_niho_user_id,c.acknowledged_at,
            c.resolved_at,c.resolution,p.public_title,
            COALESCE(so.start_at,(SELECT min(e.source_start_at) FROM external_reservations e
              WHERE e.provider_id=c.provider_id AND e.occurrence_id=c.occurrence_id)) AS occurrence_start_at
       FROM external_reservation_conflict_cases c
       JOIN experience_products p ON p.provider_id=c.provider_id AND p.id=c.product_id
       LEFT JOIN schedule_occurrences so ON so.provider_id=c.provider_id AND so.occurrence_id=c.occurrence_id
      WHERE c.provider_id=$1 AND (c.status='OPEN' OR c.resolved_at>=$2)
      ORDER BY (c.status='OPEN') DESC,c.opened_at DESC,c.id LIMIT 200`,
    [providerId, since],
  );
  const ids = cases.rows.map((row) => String(row.id));
  const members = ids.length === 0 ? [] : (await db.query<DbRow>(
    `SELECT m.case_id::text,m.member_kind,m.source_site,m.external_reservation_id,m.booking_id::text,m.seats,m.added_at,m.occurrence_id AS member_occurrence_id,
            e.status AS external_status,e.occurrence_id AS external_occurrence_id,b.status AS booking_status,b.hold_expires_at
       FROM external_reservation_conflict_members m
       LEFT JOIN external_reservations e ON e.source_site=m.source_site
        AND e.source_external_account_id=m.source_external_account_id AND e.external_reservation_id=m.external_reservation_id
       LEFT JOIN bookings b ON b.id=m.booking_id
      WHERE m.case_id=ANY($1::uuid[]) ORDER BY m.case_id,m.id`,
    [ids],
  )).rows;
  const byCase = new Map<string, ConflictMemberView[]>();
  for (const row of members) {
    const caseId = String(row.case_id);
    const list = byCase.get(caseId) ?? [];
    const base = { seats: Number(row.seats), addedAtUtc: isoValue(row, "added_at") };
    list.push(row.member_kind === "EXTERNAL"
      ? { kind: "EXTERNAL", site: String(row.source_site), externalReservationId: String(row.external_reservation_id),
        status: externalMemberStatus(row), ...base }
      : { kind: "DIRECT", bookingId: String(row.booking_id), status: directMemberStatus(row, nowUtc), ...base });
    byCase.set(caseId, list);
  }
  return cases.rows.map((row) => ({
    id: String(row.id), productId: String(row.product_id), productTitle: String(row.public_title), occurrenceId: String(row.occurrence_id),
    ...(row.occurrence_start_at === null ? {} : { occurrenceStartAtUtc: isoValue(row, "occurrence_start_at") }),
    status: row.status === "OPEN" ? "OPEN" as const : "RESOLVED" as const,
    openedAtUtc: isoValue(row, "opened_at"), lastSeenAtUtc: isoValue(row, "last_seen_at"),
    acknowledged: row.acknowledged_at !== null, assignedToMe: row.assignee_niho_user_id === viewerNihoUserId,
    ...(row.resolved_at === null ? {} : { resolvedAtUtc: isoValue(row, "resolved_at") }),
    ...(row.resolution === null ? {} : { resolution: String(row.resolution) as ConflictCaseResolution }),
    members: byCase.get(String(row.id)) ?? [],
  }));
}

function seconds(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : undefined;
}

function summary(row: DbRow | undefined): DurationSummary {
  const p50Seconds = seconds(row?.p50);
  const p95Seconds = seconds(row?.p95);
  return {
    count: Number(row?.count ?? 0),
    ...(p50Seconds === undefined ? {} : { p50Seconds }),
    ...(p95Seconds === undefined ? {} : { p95Seconds }),
  };
}

/** Aggregates in SQL over at most the newest 10,000 measurements of the last 30 days. */
export async function loadPropagationMetrics(db: Pool, providerId: string, now: Date): Promise<PropagationMetrics> {
  const nowUtc = now.toISOString();
  const fromUtc = new Date(now.getTime() - ATTENTION_WINDOW_DAYS * 86_400_000).toISOString();
  const windowed = `WITH m AS (
      SELECT * FROM channel_propagation_measurements WHERE provider_id=$1 AND detected_at>=$2 AND detected_at<=$3
       ORDER BY detected_at DESC,id LIMIT ${METRIC_ROW_LIMIT})`;
  const params = [providerId, fromUtc, nowUtc];
  const [statusRows, closeRow, lagRow, waitRow, siteRows, openRow] = await Promise.all([
    db.query<DbRow>(`${windowed} SELECT status,count(*)::int AS count,
        (SELECT count(*) FROM (SELECT 1 FROM channel_propagation_measurements
          WHERE provider_id=$1 AND detected_at>=$2 AND detected_at<=$3 LIMIT ${METRIC_ROW_LIMIT + 1}) x)::int AS total
      FROM m GROUP BY status`, params),
    db.query<DbRow>(`${windowed}, d AS (SELECT extract(epoch FROM closed_verified_at-detected_at) AS s FROM m WHERE status='COMPLETED')
      SELECT count(*)::int AS count,percentile_cont(0.5) WITHIN GROUP (ORDER BY s) AS p50,percentile_cont(0.95) WITHIN GROUP (ORDER BY s) AS p95,
             max(s) AS max,count(*) FILTER (WHERE s>3600)::int AS over_60 FROM d`, params),
    db.query<DbRow>(`${windowed}, d AS (SELECT extract(epoch FROM detected_at-source_updated_at) AS s FROM m WHERE source_updated_at IS NOT NULL)
      SELECT count(*)::int AS count,percentile_cont(0.5) WITHIN GROUP (ORDER BY s) AS p50,percentile_cont(0.95) WITHIN GROUP (ORDER BY s) AS p95 FROM d`, params),
    db.query<DbRow>(`${windowed}, d AS (SELECT extract(epoch FROM t.job_claimed_at-t.job_created_at) AS s FROM m
        JOIN channel_propagation_targets t ON t.measurement_id=m.id WHERE t.job_claimed_at IS NOT NULL AND t.job_created_at IS NOT NULL)
      SELECT count(*)::int AS count,percentile_cont(0.5) WITHIN GROUP (ORDER BY s) AS p50,percentile_cont(0.95) WITHIN GROUP (ORDER BY s) AS p95 FROM d`, params),
    db.query<DbRow>(`${windowed}
      SELECT source_site,count(*)::int AS count,
             percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM closed_verified_at-detected_at)) FILTER (WHERE status='COMPLETED') AS p95
        FROM m GROUP BY source_site ORDER BY source_site COLLATE "C" LIMIT 20`, params),
    // OPEN is not limited to the window: an old open measurement means the watchdog stopped settling.
    db.query<DbRow>(`SELECT count(*)::int AS count,min(detected_at) AS oldest FROM channel_propagation_measurements WHERE provider_id=$1 AND status='OPEN'`, [providerId]),
  ]);
  const counts: Record<PropagationStatus, number> = { OPEN: 0, COMPLETED: 0, NOT_REQUIRED: 0, ABANDONED: 0, TIMED_OUT: 0 };
  for (const row of statusRows.rows) counts[String(row.status) as PropagationStatus] = Number(row.count);
  const total = Number(statusRows.rows[0]?.total ?? 0);
  const close = closeRow.rows[0];
  const maxSeconds = seconds(close?.max);
  const oldest = openRow.rows[0]?.oldest;
  return {
    providerId, generatedAtUtc: nowUtc, fromUtc, windowDays: ATTENTION_WINDOW_DAYS, truncated: total > METRIC_ROW_LIMIT, counts,
    closeVerified: { ...summary(close), ...(maxSeconds === undefined ? {} : { maxSeconds }), over60Minutes: Number(close?.over_60 ?? 0) },
    detectionLag: summary(lagRow.rows[0]),
    queueWait: summary(waitRow.rows[0]),
    bySite: siteRows.rows.map((row) => {
      const p95 = seconds(row.p95);
      return { site: String(row.source_site), count: Number(row.count), ...(p95 === undefined ? {} : { closeVerifiedP95Seconds: p95 }) };
    }),
    open: {
      count: Number(openRow.rows[0]?.count ?? 0),
      ...(oldest === null || oldest === undefined ? {} : { oldestAgeSeconds: Math.max(0, Math.round((now.getTime() - Date.parse(isoValue(openRow.rows[0]!, "oldest"))) / 1_000)) }),
    },
  };
}
