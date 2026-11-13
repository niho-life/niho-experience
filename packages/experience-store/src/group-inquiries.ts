import { randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { StoreNotFoundError, StoreRateLimitedError, StoreValidationError } from "./errors.ts";
import {
  GROUP_INQUIRY_LIMITS,
  GROUP_INQUIRY_REPLY_BUSINESS_DAYS,
  GROUP_INQUIRY_STATUSES,
  addBusinessDays,
  checkGroupInquiry,
  type GroupInquiryDetails,
  type GroupInquiryDraft,
  type GroupInquiryEntry,
  type GroupInquiryKind,
  type GroupInquiryLocale,
  type GroupInquiryStatus,
} from "./group-inquiry-fields.ts";
import { isoValue, type DbRow } from "./rows.ts";
import { withTransaction } from "./transaction.ts";

/*
 * 団体・個別の相談 (#532, v0, migration 0074, docs/group-inquiry.md). The office's inbox for the people who write to
 * NIHO before booking anything. It keeps no inventory, payment or booking, and it is not a product's question thread
 * (guest-questions.ts, #52): nothing here reads or writes those tables.
 *
 * - `submit` keeps one inquiry and the two emails it owes (the office's notice, the sender's receipt) in one transaction.
 *   The same `clientRequestKey` is the same inquiry, so a lost answer or a double tap never makes two.
 * - The mail job claims one email at a time with a lease and reports SENT, RETRY or FAILED; a notice that never went is
 *   visible to the Admin apart from the inquiry, which was accepted all the same.
 * - The Admin console lists inquiries and edits the office's side by hand: status, who at NIHO handles it, the next due
 *   date, a note. The last editor is kept; there is no other history and no concurrency guard in v0.
 *
 * Nothing here logs. The sender's name, address and words leave this module only in the Admin reads and the claimed
 * emails. Every time is the database's clock.
 */

export const GROUP_INQUIRY_MAIL_RECIPIENTS = ["STAFF", "SENDER"] as const;
export type GroupInquiryMailRecipient = (typeof GROUP_INQUIRY_MAIL_RECIPIENTS)[number];
export type GroupInquiryMailStatus = "PENDING" | "SENDING" | "SENT" | "FAILED";
export type GroupInquiryMailOutcome = "SENT" | "RETRY" | "FAILED";

export const GROUP_INQUIRY_MAIL_LIMITS = {
  /** Claims of one email, the first included. Retries wait 2, 4, 8 and 16 minutes. */
  attempts: 5,
  claimLimitMax: 50,
  leaseSecondsMin: 30,
  leaseSecondsMax: 3600,
  listMax: 500,
} as const;

export type SubmitGroupInquiryInput = GroupInquiryDraft & { readonly clientRequestKey: unknown };
export type SubmittedGroupInquiry = {
  readonly inquiryRef: string;
  /** The same key had been accepted before: nothing new was kept (and no new emails queued). */
  readonly repeated: boolean;
  /** When the office first answers by, as told to the sender (the date, Asia/Tokyo). */
  readonly replyByDate: string;
};

/** What an email about one inquiry says. Names, addresses and the sender's words leave the store only here. */
export interface GroupInquiryMail {
  readonly inquiryId: string;
  readonly recipient: GroupInquiryMailRecipient;
  /** Claims of this email so far, this one included. */
  readonly attempts: number;
  readonly inquiryRef: string;
  readonly kind: GroupInquiryKind;
  readonly locale: GroupInquiryLocale;
  readonly contactName: string;
  readonly contactEmail: string;
  readonly message: string;
  readonly details: GroupInquiryDetails;
  readonly entry: GroupInquiryEntry;
  readonly experienceSlug: string | null;
  readonly experienceTitle: string | null;
  readonly hostName: string | null;
  readonly createdAt: string;
  /** The first answer is due on this date (Asia/Tokyo). */
  readonly replyByDate: string | null;
}

export interface GroupInquiryRecord {
  readonly id: string;
  readonly inquiryRef: string;
  readonly kind: GroupInquiryKind;
  readonly locale: GroupInquiryLocale;
  readonly contactName: string;
  readonly contactEmail: string;
  readonly message: string;
  readonly details: GroupInquiryDetails;
  readonly entry: GroupInquiryEntry;
  readonly experienceSlug: string | null;
  readonly experienceTitle: string | null;
  readonly hostName: string | null;
  readonly utmSource: string | null;
  readonly utmMedium: string | null;
  readonly utmCampaign: string | null;
  /** The date the sender was told to expect a first answer by (Asia/Tokyo). */
  readonly replyByOn: string;
  readonly status: GroupInquiryStatus;
  readonly assigneeLabel: string | null;
  readonly nextDueOn: string | null;
  readonly staffNote: string | null;
  readonly updatedByActor: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** The office's notice and the sender's receipt: an accepted inquiry whose notice failed is told apart here. */
  readonly staffMail: GroupInquiryMailStatus;
  readonly senderMail: GroupInquiryMailStatus;
}

export interface GroupInquiryList {
  readonly inquiries: readonly GroupInquiryRecord[];
  /** Every status's count, whatever the filter. */
  readonly counts: Readonly<Record<GroupInquiryStatus, number>>;
  /** Today in Asia/Tokyo (`YYYY-MM-DD`), for "overdue" on the page. */
  readonly today: string;
}

export interface GroupInquiryPatch {
  readonly status?: unknown;
  readonly assigneeLabel?: unknown;
  readonly nextDueOn?: unknown;
  readonly staffNote?: unknown;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const KEY = /^[A-Za-z0-9._:-]{8,120}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
// eslint-disable-next-line no-control-regex -- the point is to refuse control characters
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F\u2028\u2029]/;
// eslint-disable-next-line no-control-regex
const ONE_LINE_CONTROL = /[\u0000-\u001F\u007F\u2028\u2029]/;

function newInquiryRef(): string {
  const bytes = randomBytes(8);
  let ref = "IQ-";
  for (const byte of bytes) ref += CROCKFORD[byte % 32];
  return ref;
}

function boundedInteger(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new StoreValidationError(`${name} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

function dateValue(row: DbRow, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  // `pg` hands a date column back as a Date at local midnight unless the query casts it: the queries cast to text.
  return String(value);
}

function detailsOf(value: unknown): GroupInquiryDetails {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const details: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) if (typeof item === "string") details[key] = item;
  return details;
}

const RECORD_COLUMNS = `i.id, i.inquiry_ref, i.kind, i.locale, i.contact_name, i.contact_email, i.message, i.details, i.entry,
  i.interest_experience_slug, i.interest_experience_title, i.interest_host_name, i.utm_source, i.utm_medium, i.utm_campaign,
  i.reply_by_on::text AS reply_by_on, i.status, i.assignee_label, i.next_due_on::text AS next_due_on, i.staff_note, i.updated_by_actor, i.created_at, i.updated_at`;

function recordFromRow(row: DbRow): GroupInquiryRecord {
  return {
    id: String(row.id),
    inquiryRef: String(row.inquiry_ref),
    kind: String(row.kind) as GroupInquiryKind,
    locale: String(row.locale) as GroupInquiryLocale,
    contactName: String(row.contact_name),
    contactEmail: String(row.contact_email),
    message: String(row.message),
    details: detailsOf(row.details),
    entry: String(row.entry) as GroupInquiryEntry,
    experienceSlug: row.interest_experience_slug === null ? null : String(row.interest_experience_slug),
    experienceTitle: row.interest_experience_title === null ? null : String(row.interest_experience_title),
    hostName: row.interest_host_name === null ? null : String(row.interest_host_name),
    utmSource: row.utm_source === null ? null : String(row.utm_source),
    utmMedium: row.utm_medium === null ? null : String(row.utm_medium),
    utmCampaign: row.utm_campaign === null ? null : String(row.utm_campaign),
    replyByOn: String(row.reply_by_on),
    status: String(row.status) as GroupInquiryStatus,
    assigneeLabel: row.assignee_label === null ? null : String(row.assignee_label),
    nextDueOn: dateValue(row, "next_due_on"),
    staffNote: row.staff_note === null ? null : String(row.staff_note),
    updatedByActor: row.updated_by_actor === null ? null : String(row.updated_by_actor),
    createdAt: isoValue(row, "created_at"),
    updatedAt: isoValue(row, "updated_at"),
    staffMail: String(row.staff_mail ?? "PENDING") as GroupInquiryMailStatus,
    senderMail: String(row.sender_mail ?? "PENDING") as GroupInquiryMailStatus,
  };
}

export class GroupInquiryRepository {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  /**
   * Keeps one inquiry and queues its two emails. StoreValidationError for a draft the form would not have sent;
   * StoreRateLimitedError after too many from one address (or from everyone) in the last hour. The same
   * `clientRequestKey` is answered with the first inquiry's reference and `repeated: true`, before any limit.
   */
  async submit(input: SubmitGroupInquiryInput): Promise<SubmittedGroupInquiry> {
    const checked = checkGroupInquiry(input);
    if (!checked.ok) throw new StoreValidationError(`The inquiry's ${checked.problem} is not valid.`);
    const key = input.clientRequestKey;
    if (typeof key !== "string" || !KEY.test(key)) throw new StoreValidationError("clientRequestKey is not valid.");
    const value = checked.value;
    return withTransaction(this.#pool, async (client) => {
      // One submission at a time, so the counts below hold until this one is in.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('group-inquiries', 54))");
      const today = String((await client.query<DbRow>("SELECT (clock_timestamp() AT TIME ZONE 'Asia/Tokyo')::date::text AS today")).rows[0]!.today);
      const replyByDate = addBusinessDays(today, GROUP_INQUIRY_REPLY_BUSINESS_DAYS);
      const repeated = await client.query<DbRow>("SELECT inquiry_ref, reply_by_on::text AS reply_by_on FROM group_inquiries WHERE client_request_key = $1", [key]);
      if (repeated.rows[0]) return { inquiryRef: String(repeated.rows[0].inquiry_ref), repeated: true, replyByDate: String(repeated.rows[0].reply_by_on) };
      const counts = await client.query<DbRow>(
        `SELECT count(*) FILTER (WHERE contact_email_key = lower($1))::int AS by_email,
                count(*)::int AS all_of_them,
                GREATEST(1, ceil(extract(epoch FROM min(created_at) FILTER (WHERE contact_email_key = lower($1)) + interval '60 minutes' - clock_timestamp())))::int AS email_retry,
                GREATEST(1, ceil(extract(epoch FROM min(created_at) + interval '60 minutes' - clock_timestamp())))::int AS all_retry
           FROM group_inquiries WHERE created_at > clock_timestamp() - interval '60 minutes'`,
        [value.email],
      );
      const count = counts.rows[0]!;
      if (Number(count.by_email) >= GROUP_INQUIRY_LIMITS.perEmailPerHour) throw new StoreRateLimitedError(Number(count.email_retry));
      if (Number(count.all_of_them) >= GROUP_INQUIRY_LIMITS.perHour) throw new StoreRateLimitedError(Number(count.all_retry));

      const id = randomUUID();
      // A reference is unique: the (rare) collision retries a new one inside the same transaction's savepoint.
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const ref = newInquiryRef();
        await client.query("SAVEPOINT inquiry_ref");
        try {
          await client.query(
            `INSERT INTO group_inquiries
               (id, inquiry_ref, client_request_key, kind, locale, contact_name, contact_email, contact_email_key, message, details, entry,
                interest_experience_slug, interest_experience_title, interest_host_name, utm_source, utm_medium, utm_campaign, reply_by_on, next_due_on)
             VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, lower($7), $8, $9::jsonb, $10, $11, $12, $13, $14, $15, $16, $17::date, $17::date)`,
            [id, ref, key, value.kind, value.locale, value.name, value.email, value.message, JSON.stringify(value.details), value.entry,
              value.experienceSlug, value.experienceTitle, value.hostName, value.utmSource, value.utmMedium, value.utmCampaign, replyByDate],
          );
        } catch (error) {
          await client.query("ROLLBACK TO SAVEPOINT inquiry_ref");
          if ((error as { code?: string; constraint?: string }).code === "23505" && (error as { constraint?: string }).constraint === "group_inquiries_inquiry_ref_key") continue;
          throw error;
        }
        await client.query("RELEASE SAVEPOINT inquiry_ref");
        await client.query("INSERT INTO group_inquiry_mails (inquiry_id, recipient) VALUES ($1::uuid, 'STAFF'), ($1::uuid, 'SENDER')", [id]);
        return { inquiryRef: ref, repeated: false, replyByDate };
      }
      throw new StoreValidationError("No inquiry reference could be made.");
    });
  }

  /* ---------- the mail job ---------- */

  /**
   * Claims up to `limit` emails that are due (PENDING, or SENDING with a lease that ran out), the office's notices
   * first, each with a lease. A last attempt whose lease ran out without a report is closed as FAILED.
   */
  async claimMails(options: { limit: number; leaseSeconds: number }): Promise<GroupInquiryMail[]> {
    const limit = boundedInteger(options?.limit, "limit", 1, GROUP_INQUIRY_MAIL_LIMITS.claimLimitMax);
    const leaseSeconds = boundedInteger(options?.leaseSeconds, "leaseSeconds", GROUP_INQUIRY_MAIL_LIMITS.leaseSecondsMin, GROUP_INQUIRY_MAIL_LIMITS.leaseSecondsMax);
    return withTransaction(this.#pool, async (client) => {
      await client.query(
        `UPDATE group_inquiry_mails SET status = 'FAILED', lease_until = NULL
          WHERE status = 'SENDING' AND lease_until <= clock_timestamp() AND attempts >= $1`,
        [GROUP_INQUIRY_MAIL_LIMITS.attempts],
      );
      const claimed = await client.query<DbRow>(
        `WITH due AS (
           SELECT inquiry_id, recipient FROM group_inquiry_mails
            WHERE status IN ('PENDING', 'SENDING') AND attempts < $3
              AND (lease_until IS NULL OR lease_until <= clock_timestamp())
            ORDER BY created_at, CASE recipient WHEN 'STAFF' THEN 0 ELSE 1 END
            LIMIT $1
            FOR UPDATE SKIP LOCKED
         )
         UPDATE group_inquiry_mails m
            SET status = 'SENDING', attempts = m.attempts + 1, lease_until = clock_timestamp() + make_interval(secs => $2)
           FROM due
          WHERE m.inquiry_id = due.inquiry_id AND m.recipient = due.recipient
         RETURNING m.inquiry_id, m.recipient, m.attempts`,
        [limit, leaseSeconds, GROUP_INQUIRY_MAIL_LIMITS.attempts],
      );
      const mails: GroupInquiryMail[] = [];
      for (const row of claimed.rows) {
        const found = await client.query<DbRow>(
          `SELECT ${RECORD_COLUMNS} FROM group_inquiries i WHERE i.id = $1::uuid`,
          [String(row.inquiry_id)],
        );
        const inquiry = found.rows[0];
        if (!inquiry) continue;
        const record = recordFromRow(inquiry);
        mails.push({
          inquiryId: record.id,
          recipient: String(row.recipient) as GroupInquiryMailRecipient,
          attempts: Number(row.attempts),
          inquiryRef: record.inquiryRef,
          kind: record.kind,
          locale: record.locale,
          contactName: record.contactName,
          contactEmail: record.contactEmail,
          message: record.message,
          details: record.details,
          entry: record.entry,
          experienceSlug: record.experienceSlug,
          experienceTitle: record.experienceTitle,
          hostName: record.hostName,
          createdAt: record.createdAt,
          replyByDate: record.replyByOn,
        });
      }
      return mails.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || (a.recipient === b.recipient ? 0 : a.recipient === "STAFF" ? -1 : 1));
    });
  }

  /** What the mail worker reports for one claimed email. RETRY goes back with a backoff while attempts remain. */
  async recordMail(inquiryId: string, recipient: GroupInquiryMailRecipient, outcome: GroupInquiryMailOutcome): Promise<GroupInquiryMailStatus> {
    if (typeof inquiryId !== "string" || !UUID.test(inquiryId)) throw new StoreValidationError("inquiryId must be a UUID.");
    if (!(GROUP_INQUIRY_MAIL_RECIPIENTS as readonly string[]).includes(recipient)) throw new StoreValidationError("recipient is not valid.");
    if (outcome !== "SENT" && outcome !== "RETRY" && outcome !== "FAILED") throw new StoreValidationError("outcome must be SENT, RETRY or FAILED.");
    const updated = await this.#pool.query<DbRow>(
      `UPDATE group_inquiry_mails
          SET status = CASE
                WHEN $3 = 'SENT' THEN 'SENT'
                WHEN $3 = 'RETRY' AND attempts < $4 THEN 'PENDING'
                ELSE 'FAILED' END,
              sent_at = CASE WHEN $3 = 'SENT' THEN clock_timestamp() END,
              lease_until = CASE WHEN $3 = 'RETRY' AND attempts < $4
                THEN clock_timestamp() + make_interval(mins => (2 ^ attempts)::int) END
        WHERE inquiry_id = $1::uuid AND recipient = $2 AND status = 'SENDING'
        RETURNING status`,
      [inquiryId, recipient, outcome, GROUP_INQUIRY_MAIL_LIMITS.attempts],
    );
    if (updated.rows[0]) return String(updated.rows[0].status) as GroupInquiryMailStatus;
    const current = await this.#pool.query<DbRow>("SELECT status FROM group_inquiry_mails WHERE inquiry_id = $1::uuid AND recipient = $2", [inquiryId, recipient]);
    if (!current.rows[0]) throw new StoreNotFoundError("inquiry mail");
    return String(current.rows[0].status) as GroupInquiryMailStatus;
  }

  /* ---------- the Admin console ---------- */

  /**
   * The inquiries, open ones first (those past their due date lead), then by due date and newest. `status` keeps one
   * status; all when absent. Only the Admin console calls this: the caller has already checked the Admin session.
   */
  async list(options: { status?: unknown; limit?: unknown } = {}): Promise<GroupInquiryList> {
    const status = options.status === undefined || options.status === null || options.status === "" ? null : options.status;
    if (status !== null && (typeof status !== "string" || !(GROUP_INQUIRY_STATUSES as readonly string[]).includes(status))) throw new StoreValidationError("status is not valid.");
    const limit = options.limit === undefined ? 200 : boundedInteger(options.limit, "limit", 1, GROUP_INQUIRY_MAIL_LIMITS.listMax);
    const [rows, counts, today] = await Promise.all([
      this.#pool.query<DbRow>(
        `SELECT ${RECORD_COLUMNS},
                (SELECT status FROM group_inquiry_mails WHERE inquiry_id = i.id AND recipient = 'STAFF') AS staff_mail,
                (SELECT status FROM group_inquiry_mails WHERE inquiry_id = i.id AND recipient = 'SENDER') AS sender_mail
           FROM group_inquiries i
          WHERE ($1::text IS NULL OR i.status = $1)
          ORDER BY (i.status = 'DONE'), i.next_due_on NULLS LAST, i.created_at DESC, i.id
          LIMIT $2`,
        [status, limit],
      ),
      this.#pool.query<DbRow>("SELECT status, count(*)::int AS n FROM group_inquiries GROUP BY status"),
      this.#pool.query<DbRow>("SELECT (clock_timestamp() AT TIME ZONE 'Asia/Tokyo')::date::text AS today"),
    ]);
    const byStatus: Record<GroupInquiryStatus, number> = { NEW: 0, IN_PROGRESS: 0, DONE: 0 };
    for (const row of counts.rows) byStatus[String(row.status) as GroupInquiryStatus] = Number(row.n);
    return { inquiries: rows.rows.map(recordFromRow), counts: byStatus, today: String(today.rows[0]!.today) };
  }

  /**
   * Sets the office's side of one inquiry by hand. Only the fields present change; `null` (or an empty string) clears
   * the assignee, due date and note. The last editor is kept. StoreNotFoundError for an unknown inquiry.
   */
  async update(actorId: string, inquiryId: string, patch: GroupInquiryPatch): Promise<GroupInquiryRecord> {
    if (typeof actorId !== "string" || actorId.length < 1 || actorId.length > 64) throw new StoreValidationError("actorId is not valid.");
    if (typeof inquiryId !== "string" || !UUID.test(inquiryId)) throw new StoreValidationError("inquiryId must be a UUID.");
    const sets: string[] = [];
    const values: unknown[] = [inquiryId, actorId];
    const add = (column: string, value: unknown, cast = "") => {
      values.push(value);
      sets.push(`${column} = $${values.length}${cast}`);
    };
    if (patch.status !== undefined) {
      if (typeof patch.status !== "string" || !(GROUP_INQUIRY_STATUSES as readonly string[]).includes(patch.status)) throw new StoreValidationError("status is not valid.");
      add("status", patch.status);
    }
    if (patch.assigneeLabel !== undefined) {
      if (patch.assigneeLabel !== null && typeof patch.assigneeLabel !== "string") throw new StoreValidationError("assigneeLabel is not valid.");
      const label = patch.assigneeLabel === null ? "" : patch.assigneeLabel.replace(/\s+/g, " ").trim();
      if (label.length > GROUP_INQUIRY_LIMITS.assigneeMaxLength || ONE_LINE_CONTROL.test(label)) throw new StoreValidationError("assigneeLabel is not valid.");
      add("assignee_label", label === "" ? null : label);
    }
    if (patch.nextDueOn !== undefined) {
      if (patch.nextDueOn !== null && patch.nextDueOn !== "" && (typeof patch.nextDueOn !== "string" || !DATE.test(patch.nextDueOn) || Number.isNaN(Date.parse(`${patch.nextDueOn}T00:00:00Z`)))) {
        throw new StoreValidationError("nextDueOn must be a date.");
      }
      add("next_due_on", patch.nextDueOn === null || patch.nextDueOn === "" ? null : patch.nextDueOn, "::date");
    }
    if (patch.staffNote !== undefined) {
      if (patch.staffNote !== null && typeof patch.staffNote !== "string") throw new StoreValidationError("staffNote is not valid.");
      const note = patch.staffNote === null ? "" : patch.staffNote.replace(/\r\n?/g, "\n").trim();
      if (note.length > GROUP_INQUIRY_LIMITS.staffNoteMaxLength || CONTROL.test(note)) throw new StoreValidationError("staffNote is not valid.");
      add("staff_note", note === "" ? null : note);
    }
    if (sets.length === 0) throw new StoreValidationError("Nothing to change.");
    return withTransaction(this.#pool, async (client) => {
      const updated = await client.query(
        `UPDATE group_inquiries SET ${sets.join(", ")}, updated_by_actor = $2, updated_at = clock_timestamp() WHERE id = $1::uuid`,
        values,
      );
      if (!updated.rowCount) throw new StoreNotFoundError("inquiry");
      const row = await client.query<DbRow>(
        `SELECT ${RECORD_COLUMNS},
                (SELECT status FROM group_inquiry_mails WHERE inquiry_id = i.id AND recipient = 'STAFF') AS staff_mail,
                (SELECT status FROM group_inquiry_mails WHERE inquiry_id = i.id AND recipient = 'SENDER') AS sender_mail
           FROM group_inquiries i WHERE i.id = $1::uuid`,
        [inquiryId],
      );
      return recordFromRow(row.rows[0]!);
    });
  }
}
