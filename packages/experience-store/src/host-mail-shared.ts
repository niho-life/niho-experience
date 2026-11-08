import type { PoolClient } from "pg";
import { StoreValidationError } from "./errors.ts";
import { assertStoreIdentifier } from "./validation.ts";

/*
 * ホストへのメール (#194, owner decision 2026-11-01): what host-notification-addresses.ts (the addresses), host-mail-outbox.ts
 * (the mail job's side) and host-notification-outbox.ts (the transactions that write a booking's rows) share. No import of
 * those modules, so none of them imports another in a circle.
 */

/**
 * The mail job's host topics in `outbox_messages`. A booking's email has one row per person it goes to (`to`, a NIHO user ID,
 * in the payload with the push's own facts), so each email is retried on its own; the push keeps its own row and topic,
 * because a row is processed once. The address confirmation has one row per request.
 */
export const HOST_MAIL_TOPICS = {
  newBooking: "host.mail.new_booking",
  cancellation: "host.mail.cancellation",
  otaBooking: "host.mail.ota_booking",
  guestMessage: "host.mail.guest_message",
  guestQuestion: "host.mail.guest_question",
  bookingMessage: "host.mail.booking_message",
  newReview: "host.mail.new_review",
  guestEmailDeliveryFailed: "host.mail.guest_email_delivery_failed",
  dayBeforeSummary: "host.mail.day_before_summary",
  listingSuspension: "host.mail.listing_suspension",
  addressConfirmation: "host.mail.address_confirmation",
} as const;
export type HostMailTopic = (typeof HOST_MAIL_TOPICS)[keyof typeof HOST_MAIL_TOPICS];
export type HostBookingMailTopic = Exclude<HostMailTopic, typeof HOST_MAIL_TOPICS.addressConfirmation>;

export const HOST_NOTIFICATION_ADDRESS_LIMITS = {
  /** A confirmation link works for this long after the host asked for it, and once. */
  confirmationMinutes: 60,
  /** Confirmation emails one person may ask for in an hour. */
  requestsPerHour: 5,
  /** A sign-in for an invitation keeps the copied address this long before the grant exists. */
  accessGraceHours: 24,
  /** Spent and cancelled confirmations are deleted after this long. */
  confirmationKeepHours: 24,
  purgedPerRunMax: 1_000,
} as const;

const EMAIL = /^[^\s@\p{Cc}]+@[^\s@\p{Cc}]+\.[^\s@\p{Cc}]+$/u;

/** An address of the shape the tables accept (3-254 characters, one @, a dot in the domain, no space or control character). */
export function isHostEmail(value: unknown): value is string {
  return typeof value === "string" && value.length >= 3 && value.length <= 254 && EMAIL.test(value);
}

/** The same address whatever its letters' case. */
export const sameEmail = (a: string | null | undefined, b: string | null | undefined): boolean =>
  typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

/**
 * SQL: the user (an expression for a NIHO user ID) still has a reason to get this site's emails: an active membership of
 * any provider, or an active product-operator grant that has not expired.
 */
export const HOST_ACCOUNT_USABLE = (user: string) =>
  `(${user} !~ '^hst_[0-9a-f]{32}$' OR EXISTS (SELECT 1 FROM host_accounts ha WHERE ha.id=${user} AND ha.status='ACTIVE'))`;

export const HAS_HOST_ACCESS = (user: string) =>
  `(${HOST_ACCOUNT_USABLE(user)} AND (EXISTS (SELECT 1 FROM provider_memberships hm WHERE hm.niho_user_id = ${user} AND hm.active)
    OR EXISTS (SELECT 1 FROM product_operator_grants hg WHERE hg.niho_user_id = ${user} AND hg.active
                AND (hg.expires_at IS NULL OR hg.expires_at > clock_timestamp()))))`;

/**
 * Writes a booking's email rows (#194) in the transaction of the event, one per person it is for who has an address here:
 * the provider's active OWNERs, and with `productId` (an OTA booking) the product's active, unexpired operators too, as the
 * push. The address itself is read when the email is sent (it may change), and so is the person's access. Someone without an
 * address gets no row: no address is kept while host email is off, so its rows are not written then either. The number added.
 */
export async function enqueueHostBookingMails(
  client: PoolClient,
  input: {
    readonly providerId: string;
    readonly topic: HostBookingMailTopic;
    readonly aggregateType: string;
    readonly aggregateId: string;
    /** The push's key; each person's row adds a digest of their ID to it. */
    readonly deduplicationKey: string;
    /** The push's payload without the guest's name (the job reads that when it sends). */
    readonly payload: object;
    readonly productId?: string;
  },
): Promise<number> {
  assertStoreIdentifier(input.providerId, "providerId");
  if (input.productId !== undefined) assertStoreIdentifier(input.productId, "productId");
  if ("guestName" in input.payload || "to" in input.payload) throw new StoreValidationError("A host email row carries no guest name.");
  const result = await client.query(
    `INSERT INTO outbox_messages (provider_id, aggregate_type, aggregate_id, topic, deduplication_key, payload)
     SELECT $1, $2, $3, $4, $5 || ':' || md5(r.niho_user_id), $6::jsonb || jsonb_build_object('to', r.niho_user_id)
       FROM (SELECT m.niho_user_id FROM provider_memberships m
              WHERE m.provider_id = $1 AND m.active AND m.role = 'OWNER'
             UNION
             SELECT g.niho_user_id FROM product_operator_grants g
              WHERE $7::text IS NOT NULL AND g.provider_id = $1 AND g.product_id = $7 AND g.active
                AND (g.expires_at IS NULL OR g.expires_at > clock_timestamp())) r
       JOIN host_notification_addresses a ON a.niho_user_id = r.niho_user_id
      WHERE COALESCE(a.override_email, a.login_email) IS NOT NULL AND ${HOST_ACCOUNT_USABLE("r.niho_user_id")}
      -- One order whatever the collation, so the rows (and their emails) come in the same order every time.
      ORDER BY r.niho_user_id COLLATE "C"
     ON CONFLICT (provider_id, deduplication_key) DO NOTHING`,
    [input.providerId, input.aggregateType, input.aggregateId, input.topic, `host-mail:${input.deduplicationKey}`, JSON.stringify(input.payload), input.productId ?? null],
  );
  return result.rowCount ?? 0;
}
