import type { Pool, PoolClient } from "pg";
import { StoreAccessDeniedError, StoreConflictError, StoreError, StoreValidationError } from "./errors.ts";
import { calendarMembershipRole } from "./product-calendar-authorization.ts";
import { isoValue, type DbRow } from "./rows.ts";
import { withTransaction } from "./transaction.ts";
import { assertStoreIdentifier } from "./validation.ts";
import type { HostActor } from "./types.ts";

/*
 * #535 v0: one internal assignee per occurrence (開催回). The person is chosen by pressing 「対応する」; no NIHO nomination or
 * approval is needed. Assigning is not approving the guest, not payment, not confirmation and not a fee: bookings,
 * booking_guests.approval_status and the provider settlement are never written here. docs/occurrence-assignments.md.
 */

/** The store's identifier rule, also refusing anything that is not a string. */
function ident(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string") throw new StoreValidationError(`${name} must be an identifier.`);
  assertStoreIdentifier(value, name);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCK_SEED = 91;
const LIST_LIMIT = 200;
const REASON_MAX = 300;
const FEE_MAX = 10_000_000;

export type AssignmentAction = "CLAIM" | "DECLINE" | "RELEASE" | "SET_FEE";
export type AssignmentRecordedBy = "SELF" | "ADMIN";

/** Who is acting as NIHO's office. Built only after the HTTP boundary verified a current Admin. */
export interface AssignmentAdminActor { readonly nihoUserId: string }

export type AssignmentOutcome =
  | "ASSIGNED"        // this call made the person the assignee
  | "ALREADY_YOURS"   // the person already is the assignee: nothing was added
  | "TAKEN"           // someone else already is the assignee: nothing was changed
  | "DECLINED"        // 行けません recorded
  | "ALREADY_DECLINED"
  | "RELEASED"        // back to open
  | "ALREADY_OPEN"    // nobody was assigned: nothing was changed
  | "FEE_SET";

export interface AssignmentResult {
  readonly outcome: AssignmentOutcome;
  /** The command was seen before: its first result is returned and nothing was added. */
  readonly repeated: boolean;
}

export interface AssignmentOccurrence {
  readonly providerId: string;
  readonly occurrenceId: string;
  readonly productId: string;
  readonly ruleId: string;
  readonly experienceTitle: string;
  readonly localDate: string;
  readonly localStartTime: string;
  readonly startsAtUtc: string;
  /** Live requests and bookings of the occurrence (a pending or approved request still holding stock, or a confirmed booking). */
  readonly bookingCount: number;
  readonly participants: number;
  readonly firstRequestedAtUtc: string;
  readonly status: "OPEN" | "ASSIGNED";
  readonly assignedToMe: boolean;
  readonly assignedAtUtc: string | null;
  /** The caller said 行けません and has not acted since. */
  readonly declinedByMe: boolean;
  /** The caller's own agreed fee; null for everyone else's and while not set. */
  readonly agreedFeeYen: number | null;
}

export interface HostAssignmentList {
  /** 募集中: nobody is assigned. */
  readonly open: readonly AssignmentOccurrence[];
  /** The caller is the assignee. */
  readonly mine: readonly AssignmentOccurrence[];
  /** Someone else is the assignee (who it is stays unsaid): the screens show 担当済み. */
  readonly taken: readonly AssignmentOccurrence[];
}

export interface AdminAssignmentRow {
  readonly providerId: string;
  readonly occurrenceId: string;
  readonly productId: string;
  readonly ruleId: string;
  readonly experienceTitle: string;
  readonly localDate: string;
  readonly localStartTime: string;
  readonly startsAtUtc: string;
  readonly bookingCount: number;
  readonly participants: number;
  readonly firstRequestedAtUtc: string;
  readonly status: "OPEN" | "ASSIGNED";
  readonly assignee: { readonly nihoUserId: string; readonly label: string; readonly claimedAtUtc: string; readonly recordedByAdmin: boolean; readonly agreedFeeYen: number | null } | null;
  readonly declined: readonly { readonly nihoUserId: string; readonly label: string; readonly reason: string | null; readonly atUtc: string }[];
}

export interface AssignmentCandidate { readonly nihoUserId: string; readonly label: string; readonly kind: "MEMBER" | "OPERATOR" }

export interface AssignmentHistoryItem {
  readonly id: string;
  readonly atUtc: string;
  readonly action: AssignmentAction;
  readonly recordedBy: AssignmentRecordedBy;
  /** Host callers see only YOU / OTHER; the office sees the person's label. */
  readonly subject: { readonly kind: "YOU" | "OTHER" | "PERSON"; readonly label: string | null };
  readonly reason: string | null;
  readonly feeYen: number | null;
}

interface ServedOccurrence {
  readonly productId: string;
  readonly startsAt: string;
}

function uuid(value: unknown, name: string): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new StoreValidationError(`${name} must be a UUID.`);
  return value.toLowerCase();
}

function reasonOf(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new StoreValidationError("reason must be text.");
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if ([...trimmed].length > REASON_MAX || /[\u0000-\u001f\u007f]/.test(trimmed)) throw new StoreValidationError("reason is invalid.");
  return trimmed;
}

function feeOf(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > FEE_MAX) throw new StoreValidationError("agreedFeeYen must be a whole yen amount.");
  return value;
}

function target(providerId: unknown, occurrenceId: unknown): { providerId: string; occurrenceId: string } {
  ident(providerId, "providerId");
  ident(occurrenceId, "occurrenceId");
  return { providerId, occurrenceId };
}

// A request still counts while it holds stock; a confirmed booking counts. Same predicate for every read and write.
const LIVE = `b.seller_snapshot->>'salesPlan'='MANAGED_20' AND b.seller_snapshot->>'acceptanceMode'='APPROVAL'
  AND b.seller_snapshot->>'chargeMode'='PLATFORM'
  AND ((b.status='HOLD' AND g.approval_status IN ('PENDING','APPROVED') AND b.hold_expires_at > clock_timestamp()) OR b.status='CONFIRMED')`;

const LIVE_CTE = (providerFilter: string) => `
  live AS (
    SELECT b.provider_id, b.occurrence_id, count(*)::int AS booking_count,
           sum(g.adult_count + g.child_count)::int AS participants, min(b.created_at) AS first_requested_at
      FROM bookings b JOIN booking_guests g ON g.provider_id=b.provider_id AND g.booking_id=b.id
     WHERE ${providerFilter} AND ${LIVE}
     GROUP BY b.provider_id, b.occurrence_id
  )`;

const DAY = "to_char(o.local_date,'YYYY-MM-DD')";
const CLOCK = "to_char(o.local_start_time,'HH24:MI')";

function occurrenceFromRow(row: DbRow, me: string): AssignmentOccurrence {
  const assignedToMe = row.assignee !== null && String(row.assignee) === me;
  return {
    providerId: String(row.provider_id), occurrenceId: String(row.occurrence_id), productId: String(row.product_id), ruleId: String(row.rule_id),
    experienceTitle: String(row.public_title), localDate: String(row.local_day), localStartTime: String(row.local_clock),
    startsAtUtc: isoValue(row, "start_at"), bookingCount: Number(row.booking_count), participants: Number(row.participants),
    firstRequestedAtUtc: isoValue(row, "first_requested_at"), status: row.assignee === null ? "OPEN" : "ASSIGNED",
    assignedToMe, assignedAtUtc: assignedToMe ? isoValue(row, "claimed_at") : null,
    declinedByMe: row.declined_action === "DECLINE",
    agreedFeeYen: assignedToMe && row.agreed_fee_yen !== null ? Number(row.agreed_fee_yen) : null,
  };
}

export class OccurrenceAssignmentRepository {
  readonly #pool: Pool;
  constructor(pool: Pool) { this.#pool = pool; }

  /** Provider members who may serve any product (OWNER, COHOST) or a product operator for this one. */
  async #canServe(client: PoolClient, actor: HostActor, productId: string | null): Promise<boolean> {
    if (await calendarMembershipRole(client, actor, ["OWNER", "COHOST"])) return true;
    if (productId === null) return false;
    const grant = await client.query<DbRow>(
      `SELECT 1 FROM product_operator_grants
        WHERE provider_id=$1 AND product_id=$3 AND niho_user_id=$2 AND active=true
          AND (expires_at IS NULL OR expires_at>clock_timestamp()) FOR SHARE`,
      [actor.providerId, actor.nihoUserId, productId],
    );
    return grant.rows[0] !== undefined;
  }

  async #lock(client: PoolClient, providerId: string, occurrenceId: string): Promise<void> {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, $2))", [`occurrence-assignment:${providerId}:${occurrenceId}`, LOCK_SEED]);
  }

  async #occurrence(client: PoolClient, providerId: string, occurrenceId: string): Promise<ServedOccurrence | null> {
    const found = await client.query<DbRow>(
      "SELECT product_id,start_at FROM schedule_occurrences WHERE provider_id=$1 AND occurrence_id=$2",
      [providerId, occurrenceId],
    );
    const row = found.rows[0];
    return row ? { productId: String(row.product_id), startsAt: isoValue(row, "start_at") } : null;
  }

  async #needsAssignee(client: PoolClient, providerId: string, occurrenceId: string): Promise<boolean> {
    const live = await client.query<DbRow>(
      `SELECT 1 FROM bookings b
         JOIN booking_guests g ON g.provider_id=b.provider_id AND g.booking_id=b.id
         JOIN schedule_occurrences o ON o.provider_id=b.provider_id AND o.occurrence_id=b.occurrence_id
        WHERE b.provider_id=$1 AND b.occurrence_id=$2 AND o.start_at > clock_timestamp() AND ${LIVE} LIMIT 1`,
      [providerId, occurrenceId],
    );
    return live.rows[0] !== undefined;
  }

  /** A command seen before returns what it did; the same command ID with other content is refused. */
  async #replay(client: PoolClient, providerId: string, commandId: string, expect: { occurrenceId: string; action: AssignmentAction; actor: string; subject: string | null }): Promise<AssignmentResult | null> {
    const prior = await client.query<DbRow>(
      "SELECT occurrence_id,action,actor_niho_user_id,subject_niho_user_id FROM occurrence_assignment_events WHERE provider_id=$1 AND command_id=$2::uuid",
      [providerId, commandId],
    );
    const row = prior.rows[0];
    if (!row) return null;
    if (row.occurrence_id !== expect.occurrenceId || row.action !== expect.action || row.actor_niho_user_id !== expect.actor || (expect.subject !== null && row.subject_niho_user_id !== expect.subject)) {
      throw new StoreConflictError("The command ID was already used for another request.");
    }
    const outcome: Record<AssignmentAction, AssignmentOutcome> = { CLAIM: "ASSIGNED", DECLINE: "DECLINED", RELEASE: "RELEASED", SET_FEE: "FEE_SET" };
    return { outcome: outcome[expect.action], repeated: true };
  }

  async #openTerm(client: PoolClient, providerId: string, occurrenceId: string): Promise<{ id: string; assignee: string; fee: number | null } | null> {
    const term = await client.query<DbRow>(
      "SELECT id::text AS id,assignee_niho_user_id,agreed_fee_yen FROM occurrence_assignments WHERE provider_id=$1 AND occurrence_id=$2 AND released_at IS NULL FOR UPDATE",
      [providerId, occurrenceId],
    );
    const row = term.rows[0];
    return row ? { id: String(row.id), assignee: String(row.assignee_niho_user_id), fee: row.agreed_fee_yen === null ? null : Number(row.agreed_fee_yen) } : null;
  }

  async #event(client: PoolClient, input: {
    providerId: string; occurrenceId: string; commandId: string; assignmentId: string | null; action: AssignmentAction;
    recordedBy: AssignmentRecordedBy; subject: string; actor: string; reason: string | null; feeYen?: number | null;
  }): Promise<void> {
    await client.query(
      `INSERT INTO occurrence_assignment_events
         (command_id,provider_id,occurrence_id,assignment_id,action,recorded_by,subject_niho_user_id,actor_niho_user_id,reason,fee_yen)
       VALUES ($1::uuid,$2,$3,$4::uuid,$5,$6,$7,$8,$9,$10)`,
      [input.commandId, input.providerId, input.occurrenceId, input.assignmentId, input.action, input.recordedBy, input.subject, input.actor, input.reason, input.feeYen ?? null],
    );
  }

  // ---- shared state changes (the person pressed it, or the office recorded it for them) ----

  async #claim(client: PoolClient, args: { providerId: string; occurrenceId: string; commandId: string; subject: string; actor: string; recordedBy: AssignmentRecordedBy; reason: string | null }): Promise<AssignmentResult> {
    const replay = await this.#replay(client, args.providerId, args.commandId, { occurrenceId: args.occurrenceId, action: "CLAIM", actor: args.actor, subject: args.subject });
    if (replay) return replay;
    if (!await this.#needsAssignee(client, args.providerId, args.occurrenceId)) throw new StoreConflictError("The occurrence is not open for an assignee.");
    const term = await this.#openTerm(client, args.providerId, args.occurrenceId);
    if (term) return { outcome: term.assignee === args.subject ? "ALREADY_YOURS" : "TAKEN", repeated: false };
    const inserted = await client.query<DbRow>(
      `INSERT INTO occurrence_assignments (provider_id,occurrence_id,assignee_niho_user_id) VALUES ($1,$2,$3)
       ON CONFLICT DO NOTHING RETURNING id::text AS id`,
      [args.providerId, args.occurrenceId, args.subject],
    );
    const id = inserted.rows[0]?.id;
    if (typeof id !== "string") return { outcome: "TAKEN", repeated: false };
    await this.#event(client, { ...args, assignmentId: id, action: "CLAIM" });
    return { outcome: "ASSIGNED", repeated: false };
  }

  async #decline(client: PoolClient, args: { providerId: string; occurrenceId: string; commandId: string; subject: string; actor: string; recordedBy: AssignmentRecordedBy; reason: string | null }): Promise<AssignmentResult> {
    const replay = await this.#replay(client, args.providerId, args.commandId, { occurrenceId: args.occurrenceId, action: "DECLINE", actor: args.actor, subject: args.subject });
    if (replay) return replay;
    if (!await this.#needsAssignee(client, args.providerId, args.occurrenceId)) throw new StoreConflictError("The occurrence is not open for an assignee.");
    const term = await this.#openTerm(client, args.providerId, args.occurrenceId);
    if (term?.assignee === args.subject) throw new StoreConflictError("The assignee must step down instead.");
    const latest = await client.query<DbRow>(
      `SELECT action FROM occurrence_assignment_events
        WHERE provider_id=$1 AND occurrence_id=$2 AND subject_niho_user_id=$3 AND action IN ('CLAIM','DECLINE','RELEASE')
        ORDER BY id DESC LIMIT 1`,
      [args.providerId, args.occurrenceId, args.subject],
    );
    if (latest.rows[0]?.action === "DECLINE") return { outcome: "ALREADY_DECLINED", repeated: false };
    await this.#event(client, { ...args, assignmentId: null, action: "DECLINE" });
    return { outcome: "DECLINED", repeated: false };
  }

  async #release(client: PoolClient, args: { providerId: string; occurrenceId: string; commandId: string; actor: string; recordedBy: AssignmentRecordedBy; reason: string | null; onlyIfAssignee: string | null }): Promise<AssignmentResult> {
    const term = await this.#openTerm(client, args.providerId, args.occurrenceId);
    const replay = await this.#replay(client, args.providerId, args.commandId, { occurrenceId: args.occurrenceId, action: "RELEASE", actor: args.actor, subject: args.onlyIfAssignee });
    if (replay) return replay;
    if (!term) return { outcome: "ALREADY_OPEN", repeated: false };
    if (args.onlyIfAssignee !== null && term.assignee !== args.onlyIfAssignee) return { outcome: "TAKEN", repeated: false };
    await client.query("UPDATE occurrence_assignments SET released_at=clock_timestamp() WHERE id=$1::uuid AND released_at IS NULL", [term.id]);
    await this.#event(client, { providerId: args.providerId, occurrenceId: args.occurrenceId, commandId: args.commandId, assignmentId: term.id, action: "RELEASE", recordedBy: args.recordedBy, subject: term.assignee, actor: args.actor, reason: args.reason });
    return { outcome: "RELEASED", repeated: false };
  }

  // ---- people who can serve ----

  /** 募集中の回 and the回 the caller is assigned to, for one provider. */
  async list(actor: HostActor): Promise<HostAssignmentList> {
    ident(actor?.providerId, "actor.providerId");
    ident(actor?.nihoUserId, "actor.nihoUserId");
    return withTransaction(this.#pool, async (client) => {
      const wholeProvider = await calendarMembershipRole(client, actor, ["OWNER", "COHOST"]) !== null;
      const rows = await client.query<DbRow>(
        `WITH ${LIVE_CTE("b.provider_id=$1")}
         SELECT o.provider_id,o.occurrence_id,o.product_id,o.rule_id,p.public_title,${DAY} AS local_day,${CLOCK} AS local_clock,o.start_at,
                live.booking_count,live.participants,live.first_requested_at,
                t.assignee_niho_user_id AS assignee,t.claimed_at,t.agreed_fee_yen,
                (SELECT e.action FROM occurrence_assignment_events e
                  WHERE e.provider_id=o.provider_id AND e.occurrence_id=o.occurrence_id AND e.subject_niho_user_id=$2
                    AND e.action IN ('CLAIM','DECLINE','RELEASE') ORDER BY e.id DESC LIMIT 1) AS declined_action
           FROM live
           JOIN schedule_occurrences o ON o.provider_id=live.provider_id AND o.occurrence_id=live.occurrence_id
           JOIN experience_products p ON p.provider_id=o.provider_id AND p.id=o.product_id
           LEFT JOIN occurrence_assignments t ON t.provider_id=o.provider_id AND t.occurrence_id=o.occurrence_id AND t.released_at IS NULL
          WHERE o.start_at > clock_timestamp()
            AND ($3::boolean OR EXISTS (
              SELECT 1 FROM product_operator_grants g
               WHERE g.provider_id=o.provider_id AND g.product_id=o.product_id AND g.niho_user_id=$2 AND g.active=true
                 AND (g.expires_at IS NULL OR g.expires_at>clock_timestamp())))
          ORDER BY o.start_at,o.occurrence_id LIMIT ${LIST_LIMIT}`,
        [actor.providerId, actor.nihoUserId, wholeProvider],
      );
      const all = rows.rows.map((row) => occurrenceFromRow(row, actor.nihoUserId));
      return { open: all.filter((item) => item.status === "OPEN"), mine: all.filter((item) => item.assignedToMe), taken: all.filter((item) => item.status === "ASSIGNED" && !item.assignedToMe) };
    });
  }

  /** 対応する. The first valid press wins; a later one learns it was TAKEN. Pressing again is harmless. */
  async claim(actor: HostActor, input: { occurrenceId: string; commandId: string }): Promise<AssignmentResult> {
    const { providerId, occurrenceId } = target(actor?.providerId, input?.occurrenceId);
    ident(actor.nihoUserId, "actor.nihoUserId");
    const commandId = uuid(input.commandId, "commandId");
    return withTransaction(this.#pool, async (client) => {
      await this.#lock(client, providerId, occurrenceId);
      const served = await this.#occurrence(client, providerId, occurrenceId);
      if (!served || !await this.#canServe(client, actor, served.productId)) throw new StoreAccessDeniedError();
      return this.#claim(client, { providerId, occurrenceId, commandId, subject: actor.nihoUserId, actor: actor.nihoUserId, recordedBy: "SELF", reason: null });
    });
  }

  /** 行けません: optional, changes no state of the booking and no assignee. */
  async decline(actor: HostActor, input: { occurrenceId: string; commandId: string; reason?: string | null }): Promise<AssignmentResult> {
    const { providerId, occurrenceId } = target(actor?.providerId, input?.occurrenceId);
    ident(actor.nihoUserId, "actor.nihoUserId");
    const commandId = uuid(input.commandId, "commandId");
    const reason = reasonOf(input.reason);
    return withTransaction(this.#pool, async (client) => {
      await this.#lock(client, providerId, occurrenceId);
      const served = await this.#occurrence(client, providerId, occurrenceId);
      if (!served || !await this.#canServe(client, actor, served.productId)) throw new StoreAccessDeniedError();
      return this.#decline(client, { providerId, occurrenceId, commandId, subject: actor.nihoUserId, actor: actor.nihoUserId, recordedBy: "SELF", reason });
    });
  }

  /** The assignee steps down: the occurrence is open again. The guests' bookings are not touched. */
  async release(actor: HostActor, input: { occurrenceId: string; commandId: string; reason?: string | null }): Promise<AssignmentResult> {
    const { providerId, occurrenceId } = target(actor?.providerId, input?.occurrenceId);
    ident(actor.nihoUserId, "actor.nihoUserId");
    const commandId = uuid(input.commandId, "commandId");
    const reason = reasonOf(input.reason);
    return withTransaction(this.#pool, async (client) => {
      await this.#lock(client, providerId, occurrenceId);
      const served = await this.#occurrence(client, providerId, occurrenceId);
      if (!served || !await this.#canServe(client, actor, served.productId)) throw new StoreAccessDeniedError();
      return this.#release(client, { providerId, occurrenceId, commandId, actor: actor.nihoUserId, recordedBy: "SELF", reason, onlyIfAssignee: actor.nihoUserId });
    });
  }

  /** The history of one occurrence, as a person who can serve it sees it: no names, others' reasons or fees. */
  async history(actor: HostActor, input: { occurrenceId: string }): Promise<readonly AssignmentHistoryItem[]> {
    const { providerId, occurrenceId } = target(actor?.providerId, input?.occurrenceId);
    ident(actor.nihoUserId, "actor.nihoUserId");
    return withTransaction(this.#pool, async (client) => {
      const served = await this.#occurrence(client, providerId, occurrenceId);
      if (!served || !await this.#canServe(client, actor, served.productId)) throw new StoreAccessDeniedError();
      const rows = await client.query<DbRow>(
        `SELECT e.id::text AS id,e.occurred_at,e.action,e.recorded_by,e.subject_niho_user_id,e.reason,e.fee_yen
           FROM occurrence_assignment_events e WHERE e.provider_id=$1 AND e.occurrence_id=$2 ORDER BY e.id`,
        [providerId, occurrenceId],
      );
      return rows.rows.flatMap((row): AssignmentHistoryItem[] => {
        const mine = row.subject_niho_user_id === actor.nihoUserId;
        // A fee is read by its owner only; the history of someone else's fee is not shown.
        if (row.action === "SET_FEE" && !mine) return [];
        return [{
          id: String(row.id), atUtc: isoValue(row, "occurred_at"), action: row.action as AssignmentAction, recordedBy: row.recorded_by as AssignmentRecordedBy,
          subject: { kind: mine ? "YOU" : "OTHER", label: null }, reason: mine && row.reason !== null ? String(row.reason) : null,
          feeYen: mine && row.fee_yen !== null ? Number(row.fee_yen) : null,
        }];
      });
    });
  }

  // ---- NIHO's office ----

  /** The occurrences with live requests or bookings that have no assignee, then the assigned ones, with who said 行けません. */
  async adminList(actor: AssignmentAdminActor): Promise<readonly AdminAssignmentRow[]> {
    ident(actor?.nihoUserId, "actor.nihoUserId");
    const rows = await this.#pool.query<DbRow>(
      `WITH ${LIVE_CTE("true")}
       SELECT o.provider_id,o.occurrence_id,o.product_id,o.rule_id,p.public_title,${DAY} AS local_day,${CLOCK} AS local_clock,o.start_at,
              live.booking_count,live.participants,live.first_requested_at,
              t.assignee_niho_user_id AS assignee,COALESCE(ha.email,t.assignee_niho_user_id) AS assignee_label,t.claimed_at,t.agreed_fee_yen,
              (SELECT e.recorded_by='ADMIN' FROM occurrence_assignment_events e WHERE e.assignment_id=t.id AND e.action='CLAIM' LIMIT 1) AS claimed_by_admin,
              COALESCE((
                SELECT jsonb_agg(jsonb_build_object('id',d.subject_niho_user_id,'label',COALESCE(da.email,d.subject_niho_user_id),'reason',d.reason,'at',d.occurred_at) ORDER BY d.id)
                  FROM (
                    SELECT DISTINCT ON (e.subject_niho_user_id) e.id,e.subject_niho_user_id,e.action,e.reason,e.occurred_at
                      FROM occurrence_assignment_events e
                     WHERE e.provider_id=o.provider_id AND e.occurrence_id=o.occurrence_id AND e.action IN ('CLAIM','DECLINE','RELEASE')
                     ORDER BY e.subject_niho_user_id,e.id DESC
                  ) d LEFT JOIN host_accounts da ON da.id=d.subject_niho_user_id
                 WHERE d.action='DECLINE'
              ),'[]'::jsonb) AS declined
         FROM live
         JOIN schedule_occurrences o ON o.provider_id=live.provider_id AND o.occurrence_id=live.occurrence_id
         JOIN experience_products p ON p.provider_id=o.provider_id AND p.id=o.product_id
         LEFT JOIN occurrence_assignments t ON t.provider_id=o.provider_id AND t.occurrence_id=o.occurrence_id AND t.released_at IS NULL
         LEFT JOIN host_accounts ha ON ha.id=t.assignee_niho_user_id
        WHERE o.start_at > clock_timestamp()
        ORDER BY (t.id IS NOT NULL),o.start_at,o.provider_id,o.occurrence_id LIMIT ${LIST_LIMIT}`,
    );
    return rows.rows.map((row): AdminAssignmentRow => ({
      providerId: String(row.provider_id), occurrenceId: String(row.occurrence_id), productId: String(row.product_id), ruleId: String(row.rule_id),
      experienceTitle: String(row.public_title), localDate: String(row.local_day), localStartTime: String(row.local_clock),
      startsAtUtc: isoValue(row, "start_at"), bookingCount: Number(row.booking_count), participants: Number(row.participants),
      firstRequestedAtUtc: isoValue(row, "first_requested_at"), status: row.assignee === null ? "OPEN" : "ASSIGNED",
      assignee: row.assignee === null ? null : {
        nihoUserId: String(row.assignee), label: String(row.assignee_label), claimedAtUtc: isoValue(row, "claimed_at"),
        recordedByAdmin: row.claimed_by_admin === true, agreedFeeYen: row.agreed_fee_yen === null ? null : Number(row.agreed_fee_yen),
      },
      declined: (Array.isArray(row.declined) ? row.declined : []).map((item: Record<string, unknown>) => ({
        nihoUserId: String(item.id), label: String(item.label), reason: item.reason === null || item.reason === undefined ? null : String(item.reason), atUtc: new Date(String(item.at)).toISOString(),
      })),
    }));
  }

  /** The people the office may record for: provider members who can serve and operators of the product. */
  async adminCandidates(actor: AssignmentAdminActor, input: { providerId: string; occurrenceId: string }): Promise<readonly AssignmentCandidate[]> {
    ident(actor?.nihoUserId, "actor.nihoUserId");
    const { providerId, occurrenceId } = target(input?.providerId, input?.occurrenceId);
    const rows = await this.#pool.query<DbRow>(
      `SELECT m.niho_user_id AS id,COALESCE(a.email,m.niho_user_id) AS label,'MEMBER' AS kind
         FROM provider_memberships m
         LEFT JOIN host_accounts a ON a.id=m.niho_user_id
        WHERE m.provider_id=$1 AND m.active AND m.role IN ('OWNER','COHOST')
          AND (m.niho_user_id !~ '^hst_[0-9a-f]{32}$' OR a.status='ACTIVE')
       UNION ALL
       SELECT g.niho_user_id,g.assignment_label,'OPERATOR'
         FROM product_operator_grants g
         JOIN schedule_occurrences o ON o.provider_id=g.provider_id AND o.product_id=g.product_id
        WHERE g.provider_id=$1 AND o.occurrence_id=$2 AND g.active=true AND (g.expires_at IS NULL OR g.expires_at>clock_timestamp())
       ORDER BY 3,2,1`,
      [providerId, occurrenceId],
    );
    return rows.rows.map((row) => ({ nihoUserId: String(row.id), label: String(row.label), kind: row.kind === "OPERATOR" ? "OPERATOR" : "MEMBER" }));
  }

  /** 事務局が代わりに記録する: 対応する / 行けません / 外れた, for someone who can serve. Recorded as the office's. */
  async adminRecord(actor: AssignmentAdminActor, input: {
    providerId: string; occurrenceId: string; commandId: string; action: "CLAIM" | "DECLINE" | "RELEASE"; subjectNihoUserId?: string; reason?: string | null;
  }): Promise<AssignmentResult> {
    ident(actor?.nihoUserId, "actor.nihoUserId");
    const { providerId, occurrenceId } = target(input?.providerId, input?.occurrenceId);
    const commandId = uuid(input.commandId, "commandId");
    const reason = reasonOf(input.reason);
    if (input.action !== "CLAIM" && input.action !== "DECLINE" && input.action !== "RELEASE") throw new StoreValidationError("action is invalid.");
    if (input.action !== "RELEASE") ident(input.subjectNihoUserId, "subjectNihoUserId");
    return withTransaction(this.#pool, async (client) => {
      await this.#lock(client, providerId, occurrenceId);
      const served = await this.#occurrence(client, providerId, occurrenceId);
      if (!served) throw new StoreAccessDeniedError();
      if (input.action === "RELEASE") {
        return this.#release(client, { providerId, occurrenceId, commandId, actor: actor.nihoUserId, recordedBy: "ADMIN", reason, onlyIfAssignee: null });
      }
      const subject = input.subjectNihoUserId as string;
      if (!await this.#canServe(client, { providerId, nihoUserId: subject }, served.productId)) throw new StoreValidationError("The person cannot be assigned to this occurrence.");
      const args = { providerId, occurrenceId, commandId, subject, actor: actor.nihoUserId, recordedBy: "ADMIN" as const, reason };
      return input.action === "CLAIM" ? this.#claim(client, args) : this.#decline(client, args);
    });
  }

  /** The agreed amount for the current assignee, typed by hand (null clears it). Nothing is calculated or paid. */
  async adminSetAgreedFee(actor: AssignmentAdminActor, input: { providerId: string; occurrenceId: string; commandId: string; agreedFeeYen: number | null }): Promise<AssignmentResult> {
    ident(actor?.nihoUserId, "actor.nihoUserId");
    const { providerId, occurrenceId } = target(input?.providerId, input?.occurrenceId);
    const commandId = uuid(input.commandId, "commandId");
    const fee = feeOf(input.agreedFeeYen);
    return withTransaction(this.#pool, async (client) => {
      await this.#lock(client, providerId, occurrenceId);
      const term = await this.#openTerm(client, providerId, occurrenceId);
      const replay = await this.#replay(client, providerId, commandId, { occurrenceId, action: "SET_FEE", actor: actor.nihoUserId, subject: null });
      if (replay) return replay;
      if (!term) throw new StoreConflictError("The occurrence has no assignee to agree a fee with.");
      if (term.fee === fee) return { outcome: "FEE_SET", repeated: false };
      await client.query("UPDATE occurrence_assignments SET agreed_fee_yen=$2,agreed_fee_set_at=clock_timestamp() WHERE id=$1::uuid AND released_at IS NULL", [term.id, fee]);
      await this.#event(client, { providerId, occurrenceId, commandId, assignmentId: term.id, action: "SET_FEE", recordedBy: "ADMIN", subject: term.assignee, actor: actor.nihoUserId, reason: null, feeYen: fee });
      return { outcome: "FEE_SET", repeated: false };
    });
  }

  /** The whole history, with names and amounts, for the office. */
  async adminHistory(actor: AssignmentAdminActor, input: { providerId: string; occurrenceId: string }): Promise<readonly AssignmentHistoryItem[]> {
    ident(actor?.nihoUserId, "actor.nihoUserId");
    const { providerId, occurrenceId } = target(input?.providerId, input?.occurrenceId);
    const rows = await this.#pool.query<DbRow>(
      `SELECT e.id::text AS id,e.occurred_at,e.action,e.recorded_by,e.subject_niho_user_id,COALESCE(a.email,e.subject_niho_user_id) AS label,e.reason,e.fee_yen
         FROM occurrence_assignment_events e LEFT JOIN host_accounts a ON a.id=e.subject_niho_user_id
        WHERE e.provider_id=$1 AND e.occurrence_id=$2 ORDER BY e.id`,
      [providerId, occurrenceId],
    );
    if (rows.rows.length > 10_000) throw new StoreError("Unexpected history size.");
    return rows.rows.map((row) => ({
      id: String(row.id), atUtc: isoValue(row, "occurred_at"), action: row.action as AssignmentAction, recordedBy: row.recorded_by as AssignmentRecordedBy,
      subject: { kind: "PERSON" as const, label: String(row.label) }, reason: row.reason === null ? null : String(row.reason),
      feeYen: row.fee_yen === null ? null : Number(row.fee_yen),
    }));
  }
}
