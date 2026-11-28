import type { Pool, PoolClient } from "pg";
import { StoreNotFoundError, StoreValidationError } from "./errors.ts";
import type { DbRow } from "./rows.ts";
import { withTransaction } from "./transaction.ts";

/*
 * 事務局への知らせ (#711): the first time a host's page is published and the first time a host's bookings open, one email to
 * the office's mailbox (EXPERIENCE_MAIL_REPLY_TO). The row is queued in the transaction that made the change, keyed by
 * (provider, kind), so a notice is never queued twice. It carries public names and an experience title only: no guest and no
 * owner address. The mail job claims one row at a time with a lease and reports SENT, RETRY or FAILED (as the inquiry mails).
 */

export const OFFICE_NOTICE_KINDS = ["FIRST_PAGE_PUBLISHED", "FIRST_BOOKING_OPENED"] as const;
export type OfficeNoticeKind = (typeof OFFICE_NOTICE_KINDS)[number];
export type OfficeNoticeOutcome = "SENT" | "RETRY" | "FAILED";
export type OfficeNoticeStatus = "PENDING" | "SENDING" | "SENT" | "FAILED";

export const OFFICE_NOTICE_LIMITS = { attempts: 5, claimLimitMax: 50, leaseSecondsMin: 30, leaseSecondsMax: 3600 } as const;

export interface ClaimedOfficeNotice {
  readonly providerId: string;
  readonly kind: OfficeNoticeKind;
  readonly attempts: number;
  /** Changes with every claim: the report of this claim must carry it, so a worker whose lease ran out changes nothing. */
  readonly claimToken: string;
  readonly hostName: string;
  readonly hostNameEn: string | null;
  readonly route: "SELF" | "OFFICE";
  readonly experienceTitle: string | null;
  readonly createdAt: string;
}

/** What the host had done before this change: decided before the write, in the provider's locked transaction. */
export interface HostFirsts {
  readonly firstPage: boolean;
  readonly firstBooking: boolean;
}

/**
 * Whether this host has ever had a page published (any experience with first_published_at) or bookings opened (any OPENED
 * event, the migration's BACKFILL included: a host that was already selling is not new). Call under the provider's lock.
 */
export async function readHostFirsts(client: PoolClient, providerId: string): Promise<HostFirsts> {
  const result = await client.query<{ page: boolean; booking: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM experience_product_publication_states WHERE provider_id=$1 AND first_published_at IS NOT NULL) AS page,
            EXISTS (SELECT 1 FROM experience_product_booking_events WHERE provider_id=$1 AND kind='OPENED') AS booking`,
    [providerId],
  );
  return { firstPage: result.rows[0]?.page !== true, firstBooking: result.rows[0]?.booking !== true };
}

/** Queues the notices a change earned, in its transaction. Repeats and existing hosts add nothing (the key). */
export async function enqueueOfficeNotices(
  client: PoolClient,
  providerId: string,
  productId: string,
  firsts: HostFirsts,
  opened: boolean,
): Promise<void> {
  const kinds: OfficeNoticeKind[] = [];
  if (firsts.firstPage) kinds.push("FIRST_PAGE_PUBLISHED");
  if (opened && firsts.firstBooking) kinds.push("FIRST_BOOKING_OPENED");
  if (kinds.length === 0) return;
  const facts = await client.query<DbRow>(
    `SELECT profile.public_display_name,profile.public_display_name_en,
            (registration.provider_id IS NOT NULL) AS self_registered,
            COALESCE(publication.public_title,product.public_title) AS title
       FROM experience_providers provider
       LEFT JOIN experience_provider_public_profiles profile ON profile.provider_id=provider.id
       LEFT JOIN experience_provider_self_registrations registration ON registration.provider_id=provider.id
       LEFT JOIN experience_products product ON product.provider_id=provider.id AND product.id=$2
       LEFT JOIN experience_product_publication_states state ON state.provider_id=provider.id AND state.product_id=$2
       LEFT JOIN experience_product_publications publication ON publication.id=state.current_publication_id
      WHERE provider.id=$1`,
    [providerId, productId],
  );
  const row = facts.rows[0];
  const payload = {
    hostName: typeof row?.public_display_name === "string" ? row.public_display_name : providerId,
    hostNameEn: typeof row?.public_display_name_en === "string" ? row.public_display_name_en : null,
    route: row?.self_registered === true ? "SELF" : "OFFICE",
    experienceTitle: typeof row?.title === "string" ? row.title : null,
  };
  for (const kind of kinds) {
    await client.query(
      "INSERT INTO experience_office_notices (provider_id,kind,payload) VALUES ($1,$2,$3::jsonb) ON CONFLICT (provider_id,kind) DO NOTHING",
      [providerId, kind, JSON.stringify(payload)],
    );
  }
}

function boundedInteger(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new StoreValidationError(`${name} must be an integer from ${min} to ${max}.`);
  return value;
}

export class OfficeNotices {
  readonly #pool: Pool;

  constructor(pool: Pool) { this.#pool = pool; }

  /** Up to `limit` due notices (PENDING, or SENDING with a lease that ran out), each claimed with a lease. */
  async claimNotices(options: { limit: number; leaseSeconds: number }): Promise<ClaimedOfficeNotice[]> {
    const limit = boundedInteger(options?.limit, "limit", 1, OFFICE_NOTICE_LIMITS.claimLimitMax);
    const leaseSeconds = boundedInteger(options?.leaseSeconds, "leaseSeconds", OFFICE_NOTICE_LIMITS.leaseSecondsMin, OFFICE_NOTICE_LIMITS.leaseSecondsMax);
    return withTransaction(this.#pool, async (client) => {
      await client.query(
        "UPDATE experience_office_notices SET status='FAILED',lease_until=NULL WHERE status='SENDING' AND lease_until <= clock_timestamp() AND attempts >= $1",
        [OFFICE_NOTICE_LIMITS.attempts],
      );
      const claimed = await client.query<DbRow>(
        `WITH due AS (
           SELECT provider_id,kind FROM experience_office_notices
            WHERE status IN ('PENDING','SENDING') AND attempts < $3 AND (lease_until IS NULL OR lease_until <= clock_timestamp())
            ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED
         )
         UPDATE experience_office_notices n
            SET status='SENDING',attempts=n.attempts+1,claim_token=gen_random_uuid(),lease_until=clock_timestamp() + make_interval(secs => $2)
           FROM due WHERE n.provider_id=due.provider_id AND n.kind=due.kind
         RETURNING n.provider_id,n.kind,n.attempts,n.claim_token,n.payload,n.created_at`,
        [limit, leaseSeconds, OFFICE_NOTICE_LIMITS.attempts],
      );
      return claimed.rows.map((row): ClaimedOfficeNotice => {
        const payload = (row.payload ?? {}) as Record<string, unknown>;
        return {
          providerId: String(row.provider_id),
          kind: String(row.kind) as OfficeNoticeKind,
          attempts: Number(row.attempts),
          claimToken: String(row.claim_token),
          hostName: typeof payload.hostName === "string" ? payload.hostName : String(row.provider_id),
          hostNameEn: typeof payload.hostNameEn === "string" ? payload.hostNameEn : null,
          route: payload.route === "SELF" ? "SELF" : "OFFICE",
          experienceTitle: typeof payload.experienceTitle === "string" ? payload.experienceTitle : null,
          createdAt: (row.created_at instanceof Date ? row.created_at : new Date(String(row.created_at))).toISOString(),
        };
      }).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    });
  }

  /** What the mail worker reports for one claimed notice. RETRY goes back with a backoff while attempts remain. */
  /** Reports the claim `claimToken` names. A report from an earlier claim (its lease ran out and another worker claimed) changes nothing. */
  async recordNotice(providerId: string, kind: OfficeNoticeKind, outcome: OfficeNoticeOutcome, claimToken: string): Promise<OfficeNoticeStatus> {
    if (typeof claimToken !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(claimToken)) throw new StoreValidationError("claimToken must be a UUID.");
    if (typeof providerId !== "string" || providerId.length < 1 || providerId.length > 256) throw new StoreValidationError("providerId is not valid.");
    if (!(OFFICE_NOTICE_KINDS as readonly string[]).includes(kind)) throw new StoreValidationError("kind is not valid.");
    if (outcome !== "SENT" && outcome !== "RETRY" && outcome !== "FAILED") throw new StoreValidationError("outcome must be SENT, RETRY or FAILED.");
    const updated = await this.#pool.query<DbRow>(
      `UPDATE experience_office_notices
          SET status = CASE WHEN $3='SENT' THEN 'SENT' WHEN $3='RETRY' AND attempts < $4 THEN 'PENDING' ELSE 'FAILED' END,
              sent_at = CASE WHEN $3='SENT' THEN clock_timestamp() END,
              lease_until = CASE WHEN $3='RETRY' AND attempts < $4 THEN clock_timestamp() + make_interval(mins => (2 ^ attempts)::int) END,
              claim_token = NULL
        WHERE provider_id=$1 AND kind=$2 AND status='SENDING' AND claim_token=$5::uuid
        RETURNING status`,
      [providerId, kind, outcome, OFFICE_NOTICE_LIMITS.attempts, claimToken],
    );
    if (updated.rows[0]) return String(updated.rows[0].status) as OfficeNoticeStatus;
    const current = await this.#pool.query<DbRow>("SELECT status FROM experience_office_notices WHERE provider_id=$1 AND kind=$2", [providerId, kind]);
    if (!current.rows[0]) throw new StoreNotFoundError("office notice");
    return String(current.rows[0].status) as OfficeNoticeStatus;
  }
}
