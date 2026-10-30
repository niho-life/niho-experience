import type { Pool, PoolClient } from "pg";
import { isoValue, type DbRow } from "./rows.ts";

/** A Studio heartbeat older than this holds new OPEN writes and opens a WORKER_STALE incident. */
export const HEARTBEAT_STALE_MS = 90_000;
/** Unreflected desired changes, stopped Studios, and quarantines older than this are overdue/escalated. */
export const OVERDUE_MS = 60 * 60_000;
/** Admin shows the watchdog itself as stopped when its last run is older than this. */
export const WATCHDOG_STALE_MS = 5 * 60_000;
const WATCHDOG_ROW_LIMIT = 500;
const OPEN_INCIDENT_LIMIT = 5_000;

export type ChannelRuntimeIncidentKind = "WORKER_STALE" | "SYNC_OVERDUE" | "RESERVATION_READ_OVERDUE" | "ACCOUNT_QUARANTINED";
export type ChannelRuntimeIncidentTransition = "opened" | "escalated" | "resolved";
export type ChannelWorkerHealth = "FRESH" | "STALE" | "DOWN" | "NEVER";
export type ChannelIncidentDetail = Readonly<Record<string, string | number | boolean>>;

export interface ChannelWatchdogTransition {
  readonly transition: ChannelRuntimeIncidentTransition;
  readonly kind: ChannelRuntimeIncidentKind;
  readonly incidentId: string;
  readonly providerId?: string;
  readonly detail: ChannelIncidentDetail;
}

export interface ChannelWatchdogRunResult {
  readonly ranAtUtc: string;
  readonly skipped: boolean;
  readonly opened: number;
  readonly escalated: number;
  readonly resolved: number;
  readonly openIncidents: number;
  readonly transitions: readonly ChannelWatchdogTransition[];
}

export interface ChannelRuntimeWorkerView {
  readonly id: string;
  readonly displayName: string;
  readonly lastHeartbeatAtUtc?: string;
  readonly health: ChannelWorkerHealth;
  readonly openHold: boolean;
  readonly openHoldSinceUtc?: string;
  readonly assignedAccounts: number;
}

export interface ChannelRuntimeListingView {
  readonly listingId: string;
  readonly productTitle: string;
  readonly closePending: number;
  readonly openPending: number;
  readonly overdue: number;
  readonly reservationReads: boolean;
  readonly readHalted: boolean;
  readonly readLastError?: string;
}

export interface ChannelRuntimeAccountView {
  readonly id: string;
  readonly site: string;
  readonly displayName: string;
  readonly active: boolean;
  readonly version: number;
  readonly quarantineReason?: string;
  readonly quarantinedAtUtc?: string;
  readonly sync: {
    readonly closePending: number;
    readonly openPending: number;
    readonly overdue: number;
    readonly heldOpen: number;
    readonly oldestChangedAtUtc?: string;
  };
  readonly reservationReads: {
    readonly listings: number;
    readonly halted: number;
    readonly lastSuccessAtUtc?: string;
    readonly nextDueAtUtc?: string;
    readonly freshUntilUtc?: string;
  };
  readonly listings: readonly ChannelRuntimeListingView[];
}

export interface ChannelRuntimeIncidentView {
  readonly id: string;
  readonly kind: ChannelRuntimeIncidentKind;
  readonly subjectType: "worker" | "account";
  readonly subjectId: string;
  readonly openedAtUtc: string;
  readonly escalated: boolean;
  readonly acknowledged: boolean;
  readonly assignedToMe: boolean;
  readonly detail: ChannelIncidentDetail;
}

export interface ChannelRuntimeOverview {
  readonly providerId: string;
  readonly generatedAtUtc: string;
  readonly watchdogLastRunAtUtc?: string;
  readonly watchdogStale: boolean;
  /** True while any Studio for this provider holds new OPEN writes (stale/never heartbeat or unfinished re-read). */
  readonly openHold: boolean;
  /** Future occurrences whose CLOSED state is not verified on the external site. */
  readonly unclosedOccurrences: number;
  readonly workers: readonly ChannelRuntimeWorkerView[];
  readonly accounts: readonly ChannelRuntimeAccountView[];
  readonly incidents: readonly ChannelRuntimeIncidentView[];
}

/** A desired row is reflected only when the current state, desired version, and mapping were verified together. */
export function unsyncedDesiredSql(alias: string): string {
  return `(${alias}.observed_state IS DISTINCT FROM ${alias}.desired_state
    OR ${alias}.observed_desired_version IS DISTINCT FROM ${alias}.desired_version
    OR ${alias}.observed_mapping_version IS DISTINCT FROM ${alias}.mapping_version)`;
}

/**
 * True while a live Studio for the provider has an OPEN hold, has never sent a
 * heartbeat, or is older than the stale threshold. Live means an unexpired,
 * unrevoked credential with an unrevoked assignment to an active account.
 */
export function providerOpenHeldSql(providerExpr: string, nowParam: string, staleBeforeParam: string): string {
  return `EXISTS (SELECT 1 FROM channel_worker_accounts hwa
    JOIN channel_external_accounts ha ON ha.id=hwa.account_id
    JOIN channel_workers hw ON hw.id=hwa.worker_id
   WHERE ha.provider_id=${providerExpr} AND hwa.revoked_at IS NULL
     AND ha.active=true AND ha.revoked_at IS NULL AND (ha.delegated_until IS NULL OR ha.delegated_until>${nowParam})
     AND hw.revoked_at IS NULL AND hw.credential_expires_at>${nowParam}
     AND (hw.open_hold_since IS NOT NULL OR hw.last_heartbeat_at IS NULL OR hw.last_heartbeat_at<${staleBeforeParam}))`;
}

function optionalIsoValue(row: DbRow, key: string): string | undefined {
  return row[key] === null || row[key] === undefined ? undefined : isoValue(row, key);
}

function count(row: DbRow, key: string): number {
  const value = Number(row[key] ?? 0);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function seconds(fromUtc: string, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - Date.parse(fromUtc)) / 1_000));
}

export function workerHealth(lastHeartbeatAtUtc: string | undefined, nowMs: number): ChannelWorkerHealth {
  if (lastHeartbeatAtUtc === undefined) return "NEVER";
  const age = nowMs - Date.parse(lastHeartbeatAtUtc);
  if (age > OVERDUE_MS) return "DOWN";
  return age > HEARTBEAT_STALE_MS ? "STALE" : "FRESH";
}

export async function providerWorkerSignals(db: Pool | PoolClient, providerId: string, now: Date): Promise<{ readonly openHold: boolean; readonly freshWorker: boolean }> {
  const result = await db.query<DbRow>(
    `SELECT COALESCE(bool_or(w.open_hold_since IS NOT NULL OR w.last_heartbeat_at IS NULL OR w.last_heartbeat_at<$3), false) AS open_hold,
            COALESCE(bool_or(w.last_heartbeat_at>=$3), false) AS fresh_worker
       FROM channel_workers w
      WHERE w.revoked_at IS NULL AND w.credential_expires_at>$2
        AND EXISTS (SELECT 1 FROM channel_worker_accounts wa JOIN channel_external_accounts a ON a.id=wa.account_id
          WHERE wa.worker_id=w.id AND wa.revoked_at IS NULL AND a.provider_id=$1
            AND a.active=true AND a.revoked_at IS NULL AND (a.delegated_until IS NULL OR a.delegated_until>$2))`,
    [providerId, now.toISOString(), new Date(now.getTime() - HEARTBEAT_STALE_MS).toISOString()],
  );
  return { openHold: result.rows[0]?.open_hold === true, freshWorker: result.rows[0]?.fresh_worker === true };
}

interface Finding {
  readonly kind: ChannelRuntimeIncidentKind;
  readonly subjectType: "worker" | "account";
  readonly subjectId: string;
  readonly providerId: string | null;
  readonly escalateNow: boolean;
  readonly escalateAfterOpenAge: boolean;
  readonly detail: ChannelIncidentDetail;
}

function dedupeKey(kind: ChannelRuntimeIncidentKind, subjectType: string, subjectId: string): string {
  return `${kind}:${subjectType}:${subjectId}`;
}

/**
 * Runs inside the caller's transaction after it took the watchdog lock.
 * It changes only incidents, the watchdog row, and stale workers' OPEN hold.
 */
export async function runChannelWatchdog(client: PoolClient, now: Date, deployedActions: readonly string[]): Promise<Omit<ChannelWatchdogRunResult, "skipped">> {
  const nowMs = now.getTime();
  const nowUtc = now.toISOString();
  const staleBefore = new Date(nowMs - HEARTBEAT_STALE_MS).toISOString();
  const overdueBefore = new Date(nowMs - OVERDUE_MS).toISOString();
  const findings: Finding[] = [];
  const truncated = new Set<ChannelRuntimeIncidentKind>();

  const workers = await client.query<DbRow>(
    `SELECT w.id,w.last_heartbeat_at,min(wa.assigned_at) AS first_assigned_at,count(DISTINCT a.id)::int AS accounts,
            count(DISTINCT a.provider_id)::int AS providers
       FROM channel_workers w
       JOIN channel_worker_accounts wa ON wa.worker_id=w.id AND wa.revoked_at IS NULL
       JOIN channel_external_accounts a ON a.id=wa.account_id
      WHERE w.revoked_at IS NULL AND w.credential_expires_at>$1
        AND a.active=true AND a.revoked_at IS NULL AND (a.delegated_until IS NULL OR a.delegated_until>$1)
      GROUP BY w.id,w.last_heartbeat_at
     HAVING COALESCE(w.last_heartbeat_at,min(wa.assigned_at))<$2
      ORDER BY w.id COLLATE "C" LIMIT $3`,
    [nowUtc, staleBefore, WATCHDOG_ROW_LIMIT],
  );
  if (workers.rows.length === WATCHDOG_ROW_LIMIT) truncated.add("WORKER_STALE");
  const staleWorkerIds = workers.rows.map((row) => String(row.id));
  if (staleWorkerIds.length > 0) {
    const unclosed = await client.query<DbRow>(
      `SELECT wa.worker_id,count(*)::int AS close_pending
         FROM channel_worker_accounts wa
         JOIN channel_listings l ON l.account_id=wa.account_id AND l.active=true
         JOIN channel_desired_states d ON d.listing_id=l.id
        WHERE wa.worker_id=ANY($1::text[]) AND wa.revoked_at IS NULL
          AND d.desired_state='CLOSED' AND d.source_end_at>$2 AND ${unsyncedDesiredSql("d")}
        GROUP BY wa.worker_id`,
      [staleWorkerIds, nowUtc],
    );
    const closePending = new Map(unclosed.rows.map((row) => [String(row.worker_id), count(row, "close_pending")]));
    for (const row of workers.rows) {
      const lastHeartbeatAtUtc = optionalIsoValue(row, "last_heartbeat_at");
      const reference = lastHeartbeatAtUtc ?? isoValue(row, "first_assigned_at");
      findings.push({
        kind: "WORKER_STALE", subjectType: "worker", subjectId: String(row.id), providerId: null,
        escalateNow: reference <= overdueBefore, escalateAfterOpenAge: false,
        detail: {
          staleSeconds: seconds(reference, nowMs), heartbeatSeen: lastHeartbeatAtUtc !== undefined,
          accounts: count(row, "accounts"), providers: count(row, "providers"), closePending: closePending.get(String(row.id)) ?? 0,
        },
      });
    }
    // The only runtime mutation: keep new OPEN writes held until the Studio re-reads reservations.
    await client.query(
      "UPDATE channel_workers SET open_hold_since=$2 WHERE id=ANY($1::text[]) AND open_hold_since IS NULL",
      [staleWorkerIds, nowUtc],
    );
  }

  const sync = await client.query<DbRow>(
    `SELECT a.id AS account_id,a.provider_id,
            count(*) FILTER (WHERE d.desired_state='CLOSED')::int AS close_pending,
            count(*) FILTER (WHERE d.desired_state='OPEN')::int AS open_pending,
            min(d.desired_changed_at) AS oldest_changed_at
       FROM channel_desired_states d
       JOIN channel_listings l ON l.id=d.listing_id
       JOIN channel_external_accounts a ON a.id=l.account_id
       JOIN experience_products p ON p.provider_id=l.provider_id AND p.id=l.product_id
      WHERE l.active=true AND a.active=true AND a.revoked_at IS NULL AND p.status='PUBLISHED'
        AND d.source_end_at>$1 AND d.desired_changed_at<=$2 AND ${unsyncedDesiredSql("d")}
        AND ((d.desired_state='CLOSED' AND l.can_close=true
              AND (a.site || '/' || l.adapter || '@' || l.adapter_version || '/SET_CLOSED')=ANY($3::text[]))
          OR (d.desired_state='OPEN' AND l.can_open=true
              AND (a.site || '/' || l.adapter || '@' || l.adapter_version || '/SET_OPEN')=ANY($3::text[])))
      GROUP BY a.id,a.provider_id
      ORDER BY a.id COLLATE "C" LIMIT $4`,
    [nowUtc, overdueBefore, deployedActions, WATCHDOG_ROW_LIMIT],
  );
  if (sync.rows.length === WATCHDOG_ROW_LIMIT) truncated.add("SYNC_OVERDUE");
  for (const row of sync.rows) {
    findings.push({
      kind: "SYNC_OVERDUE", subjectType: "account", subjectId: String(row.account_id), providerId: String(row.provider_id),
      escalateNow: true, escalateAfterOpenAge: false,
      detail: { closePending: count(row, "close_pending"), openPending: count(row, "open_pending"), oldestChangedAtUtc: isoValue(row, "oldest_changed_at") },
    });
  }

  const reads = await client.query<DbRow>(
    `SELECT a.id AS account_id,a.provider_id,count(*)::int AS listings,
            count(*) FILTER (WHERE s.halted_at IS NOT NULL)::int AS halted,
            count(*) FILTER (WHERE s.halted_at IS NULL AND h.listing_id IS NOT NULL)::int AS stale,
            count(*) FILTER (WHERE s.halted_at IS NULL AND h.listing_id IS NULL)::int AS never_read
       FROM channel_listings l
       JOIN channel_external_accounts a ON a.id=l.account_id
       LEFT JOIN external_reservation_read_dispatch_states s ON s.provider_id=l.provider_id AND s.listing_id=l.id
       LEFT JOIN external_reservation_listing_health h ON h.provider_id=l.provider_id AND h.listing_id=l.id
      WHERE l.active=true AND l.can_read_reservations=true AND a.active=true AND a.revoked_at IS NULL
        AND (s.halted_at IS NOT NULL OR (h.listing_id IS NOT NULL AND h.fresh_until<=$1)
          OR (h.listing_id IS NULL AND s.listing_id IS NOT NULL AND s.created_at<=$2))
      GROUP BY a.id,a.provider_id
      ORDER BY a.id COLLATE "C" LIMIT $3`,
    [nowUtc, overdueBefore, WATCHDOG_ROW_LIMIT],
  );
  if (reads.rows.length === WATCHDOG_ROW_LIMIT) truncated.add("RESERVATION_READ_OVERDUE");
  for (const row of reads.rows) {
    findings.push({
      kind: "RESERVATION_READ_OVERDUE", subjectType: "account", subjectId: String(row.account_id), providerId: String(row.provider_id),
      escalateNow: false, escalateAfterOpenAge: true,
      detail: { listings: count(row, "listings"), halted: count(row, "halted"), stale: count(row, "stale"), neverRead: count(row, "never_read") },
    });
  }

  const quarantined = await client.query<DbRow>(
    `SELECT id,provider_id,quarantine_reason,quarantined_at FROM channel_external_accounts
      WHERE active=true AND revoked_at IS NULL AND quarantined_at IS NOT NULL
      ORDER BY id COLLATE "C" LIMIT $1`,
    [WATCHDOG_ROW_LIMIT],
  );
  if (quarantined.rows.length === WATCHDOG_ROW_LIMIT) truncated.add("ACCOUNT_QUARANTINED");
  for (const row of quarantined.rows) {
    const since = isoValue(row, "quarantined_at");
    findings.push({
      kind: "ACCOUNT_QUARANTINED", subjectType: "account", subjectId: String(row.id), providerId: String(row.provider_id),
      escalateNow: since <= overdueBefore, escalateAfterOpenAge: false,
      detail: { reason: String(row.quarantine_reason), quarantinedSeconds: seconds(since, nowMs) },
    });
  }

  const open = await client.query<DbRow>(
    `SELECT id,kind,provider_id,dedupe_key,opened_at,escalated_at FROM channel_runtime_incidents
      WHERE resolved_at IS NULL ORDER BY id LIMIT $1 FOR UPDATE`,
    [OPEN_INCIDENT_LIMIT],
  );
  const openByKey = new Map(open.rows.map((row) => [String(row.dedupe_key), row]));
  const transitions: ChannelWatchdogTransition[] = [];
  const seen = new Set<string>();
  const transition = (kind: ChannelRuntimeIncidentKind, name: ChannelRuntimeIncidentTransition, incidentId: string, providerId: string | null, detail: ChannelIncidentDetail) => {
    transitions.push({ transition: name, kind, incidentId, ...(providerId === null ? {} : { providerId }), detail });
  };

  for (const finding of findings) {
    const key = dedupeKey(finding.kind, finding.subjectType, finding.subjectId);
    seen.add(key);
    const existing = openByKey.get(key);
    const detail = JSON.stringify(finding.detail);
    if (existing) {
      const escalate = existing.escalated_at === null
        && (finding.escalateNow || (finding.escalateAfterOpenAge && isoValue(existing, "opened_at") <= overdueBefore));
      await client.query(
        `UPDATE channel_runtime_incidents SET last_seen_at=$2,detail=$3::jsonb,updated_at=$2,
           escalated_at=CASE WHEN $4::boolean THEN $2 ELSE escalated_at END,
           notified_escalated_at=CASE WHEN $4::boolean THEN $2 ELSE notified_escalated_at END
         WHERE id=$1 AND resolved_at IS NULL`,
        [existing.id, nowUtc, detail, escalate],
      );
      if (escalate) transition(finding.kind, "escalated", String(existing.id), finding.providerId, finding.detail);
      continue;
    }
    const inserted = await client.query<DbRow>(
      `INSERT INTO channel_runtime_incidents
        (kind,subject_type,subject_id,provider_id,dedupe_key,opened_at,last_seen_at,escalated_at,notified_open_at,notified_escalated_at,detail,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$6,CASE WHEN $7::boolean THEN $6::timestamptz END,$6,CASE WHEN $7::boolean THEN $6::timestamptz END,$8::jsonb,$6,$6)
       ON CONFLICT (dedupe_key) WHERE resolved_at IS NULL DO NOTHING RETURNING id`,
      [finding.kind, finding.subjectType, finding.subjectId, finding.providerId, key, nowUtc, finding.escalateNow, detail],
    );
    const id = inserted.rows[0]?.id;
    if (id === undefined) continue;
    transition(finding.kind, "opened", String(id), finding.providerId, finding.detail);
    if (finding.escalateNow) transition(finding.kind, "escalated", String(id), finding.providerId, finding.detail);
  }

  for (const row of open.rows) {
    const kind = String(row.kind) as ChannelRuntimeIncidentKind;
    if (seen.has(String(row.dedupe_key)) || truncated.has(kind)) continue;
    await client.query(
      `UPDATE channel_runtime_incidents SET resolved_at=$2,resolution='AUTO_RECOVERED',notified_resolved_at=$2,updated_at=$2
        WHERE id=$1 AND resolved_at IS NULL`,
      [row.id, nowUtc],
    );
    transition(kind, "resolved", String(row.id), row.provider_id === null ? null : String(row.provider_id), {});
  }

  const opened = transitions.filter((item) => item.transition === "opened").length;
  const escalated = transitions.filter((item) => item.transition === "escalated").length;
  const resolved = transitions.filter((item) => item.transition === "resolved").length;
  await client.query(
    `INSERT INTO channel_watchdog_state (id,last_run_at,last_opened,last_resolved,last_escalated,updated_at)
     VALUES (1,$1,$2,$3,$4,$1)
     ON CONFLICT (id) DO UPDATE SET last_run_at=EXCLUDED.last_run_at,last_opened=EXCLUDED.last_opened,
       last_resolved=EXCLUDED.last_resolved,last_escalated=EXCLUDED.last_escalated,updated_at=EXCLUDED.updated_at`,
    [nowUtc, opened, resolved, escalated],
  );
  const remaining = await client.query<DbRow>("SELECT count(*)::int AS count FROM channel_runtime_incidents WHERE resolved_at IS NULL");
  return { ranAtUtc: nowUtc, opened, escalated, resolved, openIncidents: count(remaining.rows[0] ?? {}, "count"), transitions };
}

export async function countOpenIncidents(db: Pool | PoolClient): Promise<number> {
  const result = await db.query<DbRow>("SELECT count(*)::int AS count FROM channel_runtime_incidents WHERE resolved_at IS NULL");
  return count(result.rows[0] ?? {}, "count");
}

function incidentDetail(value: unknown): ChannelIncidentDetail {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const detail: Record<string, string | number | boolean> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean") detail[key] = entry;
  }
  return detail;
}

export async function loadChannelRuntimeOverview(db: Pool, providerId: string, viewerNihoUserId: string, now: Date): Promise<ChannelRuntimeOverview> {
  const nowMs = now.getTime();
  const nowUtc = now.toISOString();
  const overdueBefore = new Date(nowMs - OVERDUE_MS).toISOString();
  const [watchdog, workerRows, accountRows, listingRows] = await Promise.all([
    db.query<DbRow>("SELECT last_run_at FROM channel_watchdog_state WHERE id=1"),
    db.query<DbRow>(
      `SELECT w.id,w.display_name,w.last_heartbeat_at,w.open_hold_since,count(DISTINCT a.id)::int AS assigned_accounts,
              COALESCE(bool_or(a.active AND a.revoked_at IS NULL AND (a.delegated_until IS NULL OR a.delegated_until>$2)), false) AS in_scope
         FROM channel_workers w
         JOIN channel_worker_accounts wa ON wa.worker_id=w.id AND wa.revoked_at IS NULL
         JOIN channel_external_accounts a ON a.id=wa.account_id AND a.provider_id=$1
        WHERE w.revoked_at IS NULL AND w.credential_expires_at>$2
        GROUP BY w.id ORDER BY w.display_name,w.id COLLATE "C" LIMIT 50`,
      [providerId, nowUtc],
    ),
    db.query<DbRow>(
      `SELECT id,site,display_name,active,version,quarantine_reason,quarantined_at FROM channel_external_accounts
        WHERE provider_id=$1 ORDER BY site,id COLLATE "C" LIMIT 100`,
      [providerId],
    ),
    db.query<DbRow>(
      `WITH pending AS (
         SELECT d.listing_id,
                count(*) FILTER (WHERE d.desired_state='CLOSED')::int AS close_pending,
                count(*) FILTER (WHERE d.desired_state='OPEN')::int AS open_pending,
                count(*) FILTER (WHERE d.desired_changed_at<=$3)::int AS overdue,
                min(d.desired_changed_at) AS oldest_changed_at
           FROM channel_desired_states d
          WHERE d.provider_id=$1 AND d.source_end_at>$2 AND ${unsyncedDesiredSql("d")}
          GROUP BY d.listing_id)
       SELECT l.id,l.account_id,l.can_read_reservations,p.public_title,
              COALESCE(pd.close_pending,0) AS close_pending,COALESCE(pd.open_pending,0) AS open_pending,
              COALESCE(pd.overdue,0) AS overdue,pd.oldest_changed_at,
              s.halted_at,s.last_error,s.last_success_at,s.next_due_at,h.fresh_until
         FROM channel_listings l
         JOIN experience_products p ON p.provider_id=l.provider_id AND p.id=l.product_id
         LEFT JOIN pending pd ON pd.listing_id=l.id
         LEFT JOIN external_reservation_read_dispatch_states s ON s.provider_id=l.provider_id AND s.listing_id=l.id
         LEFT JOIN external_reservation_listing_health h ON h.provider_id=l.provider_id AND h.listing_id=l.id
        WHERE l.provider_id=$1 AND l.active=true
        ORDER BY l.id COLLATE "C" LIMIT 500`,
      [providerId, nowUtc, overdueBefore],
    ),
  ]);

  const workers: ChannelRuntimeWorkerView[] = workerRows.rows.map((row) => {
    const lastHeartbeatAtUtc = optionalIsoValue(row, "last_heartbeat_at");
    const openHoldSinceUtc = optionalIsoValue(row, "open_hold_since");
    return {
      id: String(row.id), displayName: String(row.display_name),
      ...(lastHeartbeatAtUtc === undefined ? {} : { lastHeartbeatAtUtc }),
      health: workerHealth(lastHeartbeatAtUtc, nowMs), openHold: openHoldSinceUtc !== undefined,
      ...(openHoldSinceUtc === undefined ? {} : { openHoldSinceUtc }), assignedAccounts: count(row, "assigned_accounts"),
    };
  });
  const openHold = workerRows.rows.some((row, index) => row.in_scope === true && (workers[index]!.openHold || workers[index]!.health !== "FRESH"));

  const listingsByAccount = new Map<string, DbRow[]>();
  for (const row of listingRows.rows) {
    const accountId = String(row.account_id);
    listingsByAccount.set(accountId, [...(listingsByAccount.get(accountId) ?? []), row]);
  }
  const minIso = (values: readonly (string | undefined)[]) => values.filter((value): value is string => value !== undefined).sort()[0];
  const maxIso = (values: readonly (string | undefined)[]) => values.filter((value): value is string => value !== undefined).sort().at(-1);
  let unclosedOccurrences = 0;
  const accounts: ChannelRuntimeAccountView[] = accountRows.rows.map((row) => {
    const rows = listingsByAccount.get(String(row.id)) ?? [];
    const readers = rows.filter((item) => item.can_read_reservations === true);
    const closePending = rows.reduce((sum, item) => sum + count(item, "close_pending"), 0);
    const openPending = rows.reduce((sum, item) => sum + count(item, "open_pending"), 0);
    unclosedOccurrences += closePending;
    const oldestChangedAtUtc = minIso(rows.map((item) => optionalIsoValue(item, "oldest_changed_at")));
    const lastSuccessAtUtc = maxIso(readers.map((item) => optionalIsoValue(item, "last_success_at")));
    const nextDueAtUtc = minIso(readers.filter((item) => item.halted_at === null).map((item) => optionalIsoValue(item, "next_due_at")));
    const freshUntilUtc = minIso(readers.map((item) => optionalIsoValue(item, "fresh_until")));
    const quarantinedAtUtc = optionalIsoValue(row, "quarantined_at");
    return {
      id: String(row.id), site: String(row.site), displayName: String(row.display_name), active: row.active === true, version: count(row, "version"),
      ...(row.quarantine_reason === null ? {} : { quarantineReason: String(row.quarantine_reason) }),
      ...(quarantinedAtUtc === undefined ? {} : { quarantinedAtUtc }),
      sync: {
        closePending, openPending, overdue: rows.reduce((sum, item) => sum + count(item, "overdue"), 0),
        heldOpen: openHold ? openPending : 0, ...(oldestChangedAtUtc === undefined ? {} : { oldestChangedAtUtc }),
      },
      reservationReads: {
        listings: readers.length, halted: readers.filter((item) => item.halted_at !== null).length,
        ...(lastSuccessAtUtc === undefined ? {} : { lastSuccessAtUtc }), ...(nextDueAtUtc === undefined ? {} : { nextDueAtUtc }),
        ...(freshUntilUtc === undefined ? {} : { freshUntilUtc }),
      },
      listings: rows.map((item) => ({
        listingId: String(item.id), productTitle: String(item.public_title), closePending: count(item, "close_pending"),
        openPending: count(item, "open_pending"), overdue: count(item, "overdue"), reservationReads: item.can_read_reservations === true,
        readHalted: item.halted_at !== null && item.halted_at !== undefined,
        ...(item.last_error === null || item.last_error === undefined ? {} : { readLastError: String(item.last_error) }),
      })),
    };
  });

  const incidentRows = await db.query<DbRow>(
    `SELECT id,kind,subject_type,subject_id,opened_at,escalated_at,acknowledged_at,assignee_niho_user_id,detail
       FROM channel_runtime_incidents
      WHERE resolved_at IS NULL AND (provider_id=$1 OR (subject_type='worker' AND subject_id=ANY($2::text[])))
      ORDER BY escalated_at IS NULL,opened_at,id LIMIT 100`,
    [providerId, workers.map((worker) => worker.id)],
  );
  const lastRunAtUtc = watchdog.rows[0] ? isoValue(watchdog.rows[0], "last_run_at") : undefined;
  return {
    providerId, generatedAtUtc: nowUtc,
    ...(lastRunAtUtc === undefined ? {} : { watchdogLastRunAtUtc: lastRunAtUtc }),
    watchdogStale: lastRunAtUtc === undefined || nowMs - Date.parse(lastRunAtUtc) > WATCHDOG_STALE_MS,
    openHold, unclosedOccurrences, workers, accounts,
    incidents: incidentRows.rows.map((row) => ({
      id: String(row.id), kind: String(row.kind) as ChannelRuntimeIncidentKind,
      subjectType: row.subject_type === "worker" ? "worker" as const : "account" as const, subjectId: String(row.subject_id),
      openedAtUtc: isoValue(row, "opened_at"), escalated: row.escalated_at !== null, acknowledged: row.acknowledged_at !== null,
      assignedToMe: row.assignee_niho_user_id === viewerNihoUserId, detail: incidentDetail(row.detail),
    })),
  };
}
