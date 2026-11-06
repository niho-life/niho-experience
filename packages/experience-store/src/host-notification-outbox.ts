import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { StoreError, StoreValidationError } from "./errors.ts";
import { enqueueHostBookingMails, HOST_MAIL_TOPICS } from "./host-mail-shared.ts";
import { isoValue, type DbRow } from "./rows.ts";
import { assertStoreIdentifier } from "./validation.ts";

/**
 * Host push notifications persisted in `outbox_messages` (#177 P2). Guest questions and booking messages,
 * site bookings and cancellations, approval deadlines, Google calendar attention, OTA changes, new reviews and
 * operations suspensions of a listing (and their clearing) are written by their owning transactions. The existing host push job produces the next-day summary. This
 * class claims only the explicitly listed `host.notify.*` topics; guest mail and payment topics stay untouched.
 */
export const HOST_NOTIFICATION_TOPICS = {
  approvalDeadline: "host.notify.approval_deadline",
  guestMessage: "host.notify.guest_message",
  guestQuestion: "host.notify.guest_question",
  newBooking: "host.notify.new_booking",
  cancellation: "host.notify.cancellation",
  bookingMessage: "host.notify.booking_message",
  googleCalendarAttention: "host.notify.google_calendar_attention",
  otaBooking: "host.notify.ota_booking",
  newReview: "host.notify.new_review",
  guestEmailDeliveryFailed: "host.notify.guest_email_delivery_failed",
  dayBeforeSummary: "host.notify.day_before_summary",
  listingSuspension: "host.notify.listing_suspension",
} as const;
export type HostNotificationTopic = (typeof HOST_NOTIFICATION_TOPICS)[keyof typeof HOST_NOTIFICATION_TOPICS];

const TOPICS: readonly string[] = Object.values(HOST_NOTIFICATION_TOPICS);
const AGGREGATE_TYPE = "booking";
const QUESTION_AGGREGATE_TYPE = "guest_question_thread";

/**
 * What a row may carry: the booking, the experience, its date and time and the party size. There
 * is deliberately no field for a guest's name, a message's text or an amount.
 */
export interface ApprovalDeadlinePayload {
  readonly v: 1;
  readonly bookingId: string;
  readonly experienceTitle: string;
  /** Canonical UTC instant (`toISOString`). */
  readonly startsAt: string;
  readonly seats: number;
  readonly approvalDeadlineAt: string;
}

export interface GuestMessagePayload {
  readonly v: 1;
  readonly bookingId: string;
  readonly messageId: string;
  readonly experienceTitle: string;
  readonly startsAt: string;
  readonly seats: number;
}

/** A question to the host (予約前の質問): the thread and the message only, never who wrote it or what. */
export interface GuestQuestionPayload {
  readonly v: 1;
  readonly threadId: string;
  readonly messageId: string;
  readonly experienceTitle: string;
}

/**
 * A message a guest wrote on the booking page of a booking made on this site (#285 slice 6b): the thread and the
 * message, the experience, its time and the party. Never who wrote it or what.
 */
export interface BookingMessagePayload {
  readonly v: 1;
  readonly threadId: string;
  readonly messageId: string;
  readonly experienceTitle: string;
  readonly startsAt: string;
  readonly seats: number;
}

/** A guest booking confirmed on this site. `seats` is the party (adults and children). */
export interface NewBookingPayload {
  readonly v: 1;
  readonly bookingId: string;
  readonly experienceTitle: string;
  readonly startsAt: string;
  readonly seats: number;
}

/**
 * A guest booking made on this site that the guest or NIHO support cancelled (#285 slice 7): the same facts as
 * a new booking. A host who cancels gets nothing for their own cancellation.
 */
export type CancellationPayload = NewBookingPayload;

/** A new public review; no guest name, review body or booking identifier leaves the store. */
export interface NewReviewPayload {
  readonly v: 1;
  readonly reviewId: string;
  readonly experienceTitle: string;
}

/** A guest booking email was rejected by the recipient's mail server. No guest identifier or address is included. */
export interface GuestEmailDeliveryFailedPayload {
  readonly v: 1;
  readonly bookingId: string;
  readonly classification: "NO_SUCH_ADDRESS" | "NO_SUCH_DOMAIN" | "REJECTED_BY_SERVER" | "MAILBOX_FULL" | "TEMPORARY_FAILED" | "OTHER";
  readonly experienceTitle: string;
  readonly startsAt: string;
  readonly seats: number;
}

/** One provider's counts for confirmed bookings on a Japan-local date. No guest or product details. */
export interface DayBeforeSummaryPayload {
  readonly v: 1;
  readonly localDate: string;
  readonly bookingCount: number;
  readonly participantCount: number;
}

/**
 * A Google calendar this site reads for busy times could not be read (#238): the provider-wide one (`PROVIDER`) or a
 * venue's or instructor's (`RESOURCE`). `REVOKED`: Google refused the connection; `UNAVAILABLE`: the reads keep failing.
 * New bookings that need it stay closed until a read succeeds. Never the calendar's ID or name, or whose it is.
 */
export interface GoogleCalendarAttentionPayload {
  readonly v: 1;
  readonly input: "PROVIDER" | "RESOURCE";
  readonly reason: "REVOKED" | "UNAVAILABLE";
}

/** What happened to a booking on a reservation site, as the ledger read it. */
export const OTA_BOOKING_CHANGES = ["NEW", "CANCELLED", "RESCHEDULED"] as const;
export type OtaBookingChange = (typeof OTA_BOOKING_CHANGES)[number];

/**
 * A booking on a reservation site (Airbnb, GetYourGuide, …) that is new, cancelled or moved (#194). The owner decided
 * (2026-11-01) that the host learns which site it came from and who booked: the site, the experience, its time, the
 * party size and the guest's name, never a contact or an amount (those are in /host). `ref` is the reservation's host
 * handle (external_reservations.host_ref), never the site's account or reservation ID. `previousStartsAt` is the time it
 * moved from (RESCHEDULED only). `guestName` is there only when the site gave one and the guest details are kept; the
 * push job removes it from the row once the row is done, and the mail job's erasure from a row never sent.
 */
export interface OtaBookingPayload {
  readonly v: 1;
  readonly change: OtaBookingChange;
  readonly site: string;
  readonly ref: string;
  readonly productId: string;
  readonly experienceTitle: string;
  readonly startsAt: string;
  readonly previousStartsAt?: string;
  readonly seats: number;
  readonly guestName?: string;
}

/** 運営停止 (`SUSPENDED`) or its clearing by operations (`CLEARED`, #109/#369). */
export const LISTING_SUSPENSION_CHANGES = ["SUSPENDED", "CLEARED"] as const;
export type ListingSuspensionChange = (typeof LISTING_SUSPENSION_CHANGES)[number];

/**
 * Operations stopped one listing, or cleared that stop (#109, #369: 旧事前審査の結果通知 is gone; this replaces it).
 * The product and its title only: never the reason code, the operator's NIHO user ID or the product's text. The host
 * reads the details in /host. A clearing does not put the listing back: the OWNER still resumes it there.
 */
export interface ListingSuspensionPayload {
  readonly v: 1;
  readonly productId: string;
  readonly experienceTitle: string;
  readonly change: ListingSuspensionChange;
}

/** One claimed row. `id` is the row's bigint as text; the payload is parsed by the consumer. */
export interface ClaimedHostNotification {
  readonly id: string;
  readonly providerId: string;
  readonly topic: string;
  readonly payload: unknown;
  /** Claims so far, this one included. */
  readonly attempts: number;
  readonly createdAt: string;
}

const PUBLIC_ID = /^[A-Za-z0-9_-]{1,48}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;
const ROW_ID = /^[1-9][0-9]{0,18}$/;
const TITLE_MAX = 200;
const SEATS_MAX = 500;
const HOUR_MS = 60 * 60 * 1000;
const APPROVAL_KEYS = ["approvalDeadlineAt", "bookingId", "experienceTitle", "seats", "startsAt", "v"];
const MESSAGE_KEYS = ["bookingId", "experienceTitle", "messageId", "seats", "startsAt", "v"];
const QUESTION_KEYS = ["experienceTitle", "messageId", "threadId", "v"];
const NEW_BOOKING_KEYS = ["bookingId", "experienceTitle", "seats", "startsAt", "v"];
const BOOKING_MESSAGE_KEYS = ["experienceTitle", "messageId", "seats", "startsAt", "threadId", "v"];
const GOOGLE_ATTENTION_KEYS = ["input", "reason", "v"];
const NEW_REVIEW_KEYS = ["experienceTitle", "reviewId", "v"];
const GUEST_EMAIL_DELIVERY_FAILED_KEYS = ["bookingId", "classification", "experienceTitle", "seats", "startsAt", "v"];
const DAY_BEFORE_SUMMARY_KEYS = ["bookingCount", "localDate", "participantCount", "v"];
const OTA_BOOKING_KEYS = ["change", "experienceTitle", "productId", "ref", "seats", "site", "startsAt", "v"];
const LISTING_SUSPENSION_KEYS = ["change", "experienceTitle", "productId", "v"];
/** The store's product identifier (validation.ts), so a row's product is one the store could have written. */
const PRODUCT_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
/** What a listing's push says when its title cannot be read (a product title is never empty, so this is a fallback only). */
export const LISTING_SUSPENSION_FALLBACK_TITLE = "体験";
const OTA_SITE = /^[A-Za-z][A-Za-z0-9]{0,79}$/;
const HOST_REF = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GUEST_NAME_MAX = 200;
const OTA_SEATS_MAX = 1_000;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const publicId = (value: unknown): value is string => typeof value === "string" && PUBLIC_ID.test(value);
const title = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= TITLE_MAX;
const seats = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 1 && (value as number) <= SEATS_MAX;

/** An ISO 8601 instant as `toISOString` writes it, or null. */
function canonicalInstant(value: unknown): string | null {
  if (typeof value !== "string" || !ISO_INSTANT.test(value)) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

/** Exactly these keys, no more and no fewer. */
function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(record).sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

/** A stored instant: a string already canonical, so a hand-written row in another form (or a JSON null) is refused. */
const storedInstant = (value: unknown): value is string => typeof value === "string" && canonicalInstant(value) === value;

/** The approval reminder's payload, or null for anything else (an unknown key, a wrong type). */
export function parseApprovalDeadlinePayload(value: unknown): ApprovalDeadlinePayload | null {
  if (!isRecord(value) || !hasExactKeys(value, APPROVAL_KEYS) || value.v !== 1) return null;
  const { bookingId, experienceTitle, startsAt, seats: count, approvalDeadlineAt } = value;
  if (!publicId(bookingId) || !title(experienceTitle) || !storedInstant(startsAt) || !seats(count) || !storedInstant(approvalDeadlineAt)) return null;
  return { v: 1, bookingId, experienceTitle, startsAt, seats: count, approvalDeadlineAt };
}

/** The guest message's payload, or null for anything else. */
export function parseGuestMessagePayload(value: unknown): GuestMessagePayload | null {
  if (!isRecord(value) || !hasExactKeys(value, MESSAGE_KEYS) || value.v !== 1) return null;
  const { bookingId, messageId, experienceTitle, startsAt, seats: count } = value;
  if (!publicId(bookingId) || !publicId(messageId) || !title(experienceTitle) || !storedInstant(startsAt) || !seats(count)) return null;
  return { v: 1, bookingId, messageId, experienceTitle, startsAt, seats: count };
}

/** The question's payload, or null for anything else. */
export function parseGuestQuestionPayload(value: unknown): GuestQuestionPayload | null {
  if (!isRecord(value) || !hasExactKeys(value, QUESTION_KEYS) || value.v !== 1) return null;
  const { threadId, messageId, experienceTitle } = value;
  if (!publicId(threadId) || !publicId(messageId) || !title(experienceTitle)) return null;
  return { v: 1, threadId, messageId, experienceTitle };
}

/** The booking message's payload, or null for anything else. */
export function parseBookingMessagePayload(value: unknown): BookingMessagePayload | null {
  if (!isRecord(value) || !hasExactKeys(value, BOOKING_MESSAGE_KEYS) || value.v !== 1) return null;
  const { threadId, messageId, experienceTitle, startsAt, seats: count } = value;
  if (!publicId(threadId) || !publicId(messageId) || !title(experienceTitle) || !storedInstant(startsAt) || !seats(count)) return null;
  return { v: 1, threadId, messageId, experienceTitle, startsAt, seats: count };
}

/** The new booking's payload, or null for anything else. */
export function parseNewBookingPayload(value: unknown): NewBookingPayload | null {
  if (!isRecord(value) || !hasExactKeys(value, NEW_BOOKING_KEYS) || value.v !== 1) return null;
  const { bookingId, experienceTitle, startsAt, seats: count } = value;
  if (!publicId(bookingId) || !title(experienceTitle) || !storedInstant(startsAt) || !seats(count)) return null;
  return { v: 1, bookingId, experienceTitle, startsAt, seats: count };
}

/** The cancellation's payload (the same keys as a new booking's), or null for anything else. */
export function parseCancellationPayload(value: unknown): CancellationPayload | null {
  return parseNewBookingPayload(value);
}

export function parseNewReviewPayload(value: unknown): NewReviewPayload | null {
  if (!isRecord(value) || !hasExactKeys(value, NEW_REVIEW_KEYS) || value.v !== 1) return null;
  if (typeof value.reviewId !== "string" || !HOST_REF.test(value.reviewId) || !title(value.experienceTitle)) return null;
  return { v: 1, reviewId: value.reviewId, experienceTitle: value.experienceTitle };
}

export function parseGuestEmailDeliveryFailedPayload(value: unknown): GuestEmailDeliveryFailedPayload | null {
  if (!isRecord(value) || !hasExactKeys(value, GUEST_EMAIL_DELIVERY_FAILED_KEYS) || value.v !== 1) return null;
  const { bookingId, classification, experienceTitle, startsAt, seats: count } = value;
  if (!HOST_REF.test(String(bookingId)) || !title(experienceTitle) || !storedInstant(startsAt) || !seats(count)) return null;
  if (!["NO_SUCH_ADDRESS", "NO_SUCH_DOMAIN", "REJECTED_BY_SERVER", "MAILBOX_FULL", "TEMPORARY_FAILED", "OTHER"].includes(String(classification))) return null;
  return { v: 1, bookingId: String(bookingId), classification: classification as GuestEmailDeliveryFailedPayload["classification"], experienceTitle, startsAt, seats: count };
}

export function parseDayBeforeSummaryPayload(value: unknown): DayBeforeSummaryPayload | null {
  if (!isRecord(value) || !hasExactKeys(value, DAY_BEFORE_SUMMARY_KEYS) || value.v !== 1) return null;
  const { localDate, bookingCount, participantCount } = value;
  if (typeof localDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(localDate)) return null;
  const date = new Date(`${localDate}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== localDate) return null;
  if (!Number.isSafeInteger(bookingCount) || (bookingCount as number) < 1
    || !Number.isSafeInteger(participantCount) || (participantCount as number) < 1) return null;
  return { v: 1, localDate, bookingCount: bookingCount as number, participantCount: participantCount as number };
}

export function parseGoogleCalendarAttentionPayload(value: unknown): GoogleCalendarAttentionPayload | null {
  if (!isRecord(value) || !hasExactKeys(value, GOOGLE_ATTENTION_KEYS) || value.v !== 1) return null;
  if (value.input !== "PROVIDER" && value.input !== "RESOURCE") return null;
  if (value.reason !== "REVOKED" && value.reason !== "UNAVAILABLE") return null;
  return { v: 1, input: value.input, reason: value.reason };
}

const guestName = (value: unknown): value is string => typeof value === "string" && value.length >= 1 && value.length <= GUEST_NAME_MAX
  && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);

/** The OTA booking's payload, or null for anything else (an unknown key, a wrong type, a move without its old time). */
export function parseOtaBookingPayload(value: unknown): OtaBookingPayload | null {
  if (!isRecord(value) || value.v !== 1) return null;
  const optional = [...(value.change === "RESCHEDULED" ? ["previousStartsAt"] : []), ...("guestName" in value ? ["guestName"] : [])];
  if (!hasExactKeys(value, [...OTA_BOOKING_KEYS, ...optional].sort())) return null;
  const { change, site, ref, productId, experienceTitle, startsAt, previousStartsAt, seats: count, guestName: name } = value;
  if (!(OTA_BOOKING_CHANGES as readonly unknown[]).includes(change) || typeof site !== "string" || !OTA_SITE.test(site)
    || typeof ref !== "string" || !HOST_REF.test(ref) || typeof productId !== "string" || productId.length < 1 || productId.length > 256
    || !title(experienceTitle) || !storedInstant(startsAt) || !Number.isInteger(count) || (count as number) < 1 || (count as number) > OTA_SEATS_MAX
    || (change === "RESCHEDULED" && !storedInstant(previousStartsAt)) || (name !== undefined && !guestName(name))) return null;
  return {
    v: 1, change: change as OtaBookingChange, site, ref, productId, experienceTitle, startsAt,
    ...(change === "RESCHEDULED" ? { previousStartsAt: previousStartsAt as string } : {}),
    seats: count as number,
    ...(name === undefined ? {} : { guestName: name as string }),
  };
}

/** The listing suspension's payload, or null for anything else (an unknown key, a wrong type, another change). */
export function parseListingSuspensionPayload(value: unknown): ListingSuspensionPayload | null {
  if (!isRecord(value) || !hasExactKeys(value, LISTING_SUSPENSION_KEYS) || value.v !== 1) return null;
  const { productId, experienceTitle, change } = value;
  if (typeof productId !== "string" || !PRODUCT_ID.test(productId) || !title(experienceTitle)
    || !(LISTING_SUSPENSION_CHANGES as readonly unknown[]).includes(change)) return null;
  return { v: 1, productId, experienceTitle, change: change as ListingSuspensionChange };
}

/**
 * An experience's title as a row carries it: a product title may be longer than a row allows (300
 * against 200), and a notification must not fail the guest's question or the payment over it.
 */
function clippedTitle(value: string): string {
  const clean = value.replace(/\s+/g, " ").trim();
  if (clean.length <= TITLE_MAX) return clean;
  // Whole code points only: half of a surrogate pair is not valid JSON, and jsonb would refuse the row (and the
  // question or the payment with it).
  let clipped = "";
  for (const character of clean) {
    if (clipped.length + character.length > TITLE_MAX - 1) break;
    clipped += character;
  }
  return `${clipped}…`;
}

interface BookingFacts {
  readonly providerId: string;
  readonly bookingId: string;
  readonly experienceTitle: string;
  readonly startsAt: string;
  readonly seats: number;
}

function validBooking(input: BookingFacts): { startsAt: string } {
  assertStoreIdentifier(input.providerId, "providerId");
  if (!publicId(input.bookingId)) throw new StoreValidationError("bookingId must contain 1-48 letters, digits, '_' or '-'.");
  if (!title(input.experienceTitle)) throw new StoreValidationError(`experienceTitle must contain 1-${TITLE_MAX} characters.`);
  if (!seats(input.seats)) throw new StoreValidationError(`seats must be an integer from 1 to ${SEATS_MAX}.`);
  const startsAt = canonicalInstant(input.startsAt);
  if (startsAt === null) throw new StoreValidationError("startsAt must be an ISO 8601 instant.");
  return { startsAt };
}

async function insertRow(
  client: PoolClient,
  row: { providerId: string; bookingId: string; topic: HostNotificationTopic; deduplicationKey: string; payload: object; availableAt: string | null; aggregateType?: string },
): Promise<number> {
  const result = await client.query(
    `INSERT INTO outbox_messages (provider_id, aggregate_type, aggregate_id, topic, deduplication_key, payload, available_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, COALESCE($7::timestamptz, clock_timestamp()))
     ON CONFLICT (provider_id, deduplication_key) DO NOTHING`,
    [row.providerId, row.aggregateType ?? AGGREGATE_TYPE, row.bookingId, row.topic, row.deduplicationKey, JSON.stringify(row.payload), row.availableAt],
  );
  return result.rowCount ?? 0;
}

/** Written in the review transaction; retries of the same one-time link cannot produce another push. */
export async function enqueueNewReviewNotification(
  client: PoolClient,
  input: { readonly providerId: string; readonly reviewId: string; readonly experienceTitle: string },
): Promise<number> {
  assertStoreIdentifier(input.providerId, "providerId");
  if (!HOST_REF.test(input.reviewId)) throw new StoreValidationError("reviewId must be a UUID.");
  const experienceTitle = clippedTitle(input.experienceTitle);
  if (!title(experienceTitle)) throw new StoreValidationError("experienceTitle must not be empty.");
  return insertRow(client, {
    providerId: input.providerId,
    bookingId: input.reviewId,
    aggregateType: "guest_review",
    topic: HOST_NOTIFICATION_TOPICS.newReview,
    deduplicationKey: `host-push:new-review:${input.reviewId}`,
    payload: { v: 1, reviewId: input.reviewId, experienceTitle } satisfies NewReviewPayload,
    availableAt: null,
  });
}

/**
 * A booking waiting for the host's approval: reminders 6 hours and 1 hour before its deadline (the
 * host console's 設定 › 通知 promises both). A reminder whose time has passed is skipped; with less
 * than an hour left, the 1-hour one is due now; past the deadline, nothing. Called in the booking's
 * own transaction. The number of new rows (a repeat adds none).
 */
export async function enqueueApprovalDeadlineReminders(
  client: PoolClient,
  input: BookingFacts & { readonly approvalDeadlineAt: string; readonly now: Date },
): Promise<number> {
  const { startsAt } = validBooking(input);
  const approvalDeadlineAt = canonicalInstant(input.approvalDeadlineAt);
  if (approvalDeadlineAt === null) throw new StoreValidationError("approvalDeadlineAt must be an ISO 8601 instant.");
  const now = input.now.getTime();
  if (!Number.isFinite(now)) throw new StoreValidationError("now must be a valid time.");
  const deadline = Date.parse(approvalDeadlineAt);
  if (deadline <= now) return 0;

  const payload: ApprovalDeadlinePayload = { v: 1, bookingId: input.bookingId, experienceTitle: input.experienceTitle, startsAt, seats: input.seats, approvalDeadlineAt };
  const due: [string, number][] = [];
  if (deadline - 6 * HOUR_MS > now) due.push(["6h", deadline - 6 * HOUR_MS]);
  due.push(["1h", Math.max(deadline - HOUR_MS, now)]);
  let inserted = 0;
  for (const [lead, at] of due) {
    inserted += await insertRow(client, {
      providerId: input.providerId,
      bookingId: input.bookingId,
      topic: HOST_NOTIFICATION_TOPICS.approvalDeadline,
      deduplicationKey: `host-push:approval-deadline:${input.bookingId}:${lead}`,
      payload,
      availableAt: new Date(at).toISOString(),
    });
  }
  return inserted;
}

/** Approved, declined, cancelled or expired: the booking's unsent reminders are closed. The number closed. */
export async function cancelApprovalDeadlineReminders(client: PoolClient, input: { readonly providerId: string; readonly bookingId: string }): Promise<number> {
  assertStoreIdentifier(input.providerId, "providerId");
  if (!publicId(input.bookingId)) throw new StoreValidationError("bookingId must contain 1-48 letters, digits, '_' or '-'.");
  const result = await client.query(
    `UPDATE outbox_messages SET processed_at = clock_timestamp()
      WHERE provider_id = $1 AND topic = $2 AND aggregate_type = $3 AND aggregate_id = $4 AND processed_at IS NULL`,
    [input.providerId, HOST_NOTIFICATION_TOPICS.approvalDeadline, AGGREGATE_TYPE, input.bookingId],
  );
  return result.rowCount ?? 0;
}

/** A guest wrote to the host: one notification per message, due now. 1 when added, 0 for a repeat. */
export async function enqueueGuestMessageNotification(client: PoolClient, input: BookingFacts & { readonly messageId: string }): Promise<number> {
  const { startsAt } = validBooking(input);
  if (!publicId(input.messageId)) throw new StoreValidationError("messageId must contain 1-48 letters, digits, '_' or '-'.");
  const payload: GuestMessagePayload = { v: 1, bookingId: input.bookingId, messageId: input.messageId, experienceTitle: input.experienceTitle, startsAt, seats: input.seats };
  return insertRow(client, {
    providerId: input.providerId,
    bookingId: input.bookingId,
    topic: HOST_NOTIFICATION_TOPICS.guestMessage,
    deduplicationKey: `host-push:guest-message:${input.messageId}`,
    payload,
    availableAt: null,
  });
}

/**
 * A guest asked the host a question or answered through the reply page (予約前の質問): one notification
 * per message, due now, sent as GUEST_MESSAGE (stoppable in 設定 › 通知). Called in the message's own
 * transaction. 1 when added, 0 for a repeat.
 */
export async function enqueueGuestQuestionNotification(
  client: PoolClient,
  input: { readonly providerId: string; readonly threadId: string; readonly messageId: string; readonly experienceTitle: string },
): Promise<number> {
  assertStoreIdentifier(input.providerId, "providerId");
  if (!publicId(input.threadId)) throw new StoreValidationError("threadId must contain 1-48 letters, digits, '_' or '-'.");
  if (!publicId(input.messageId)) throw new StoreValidationError("messageId must contain 1-48 letters, digits, '_' or '-'.");
  const experienceTitle = typeof input.experienceTitle === "string" ? clippedTitle(input.experienceTitle) : "";
  if (!title(experienceTitle)) throw new StoreValidationError("experienceTitle must contain text.");
  const payload: GuestQuestionPayload = { v: 1, threadId: input.threadId, messageId: input.messageId, experienceTitle };
  return insertRow(client, {
    providerId: input.providerId,
    bookingId: input.threadId,
    aggregateType: QUESTION_AGGREGATE_TYPE,
    topic: HOST_NOTIFICATION_TOPICS.guestQuestion,
    deduplicationKey: `host-push:guest-question:${input.messageId}`,
    payload,
    availableAt: null,
  });
}

/**
 * A guest wrote on the booking page of a booking made on this site (#285 slice 6b): one notification per message,
 * due now, sent as GUEST_MESSAGE (stoppable in 設定 › 通知). Called in the message's own transaction. 1 when added,
 * 0 for a repeat.
 */
export async function enqueueBookingMessageNotification(
  client: PoolClient,
  input: { readonly providerId: string; readonly threadId: string; readonly messageId: string; readonly experienceTitle: string; readonly startsAt: string; readonly seats: number },
): Promise<number> {
  assertStoreIdentifier(input.providerId, "providerId");
  if (!publicId(input.threadId)) throw new StoreValidationError("threadId must contain 1-48 letters, digits, '_' or '-'.");
  if (!publicId(input.messageId)) throw new StoreValidationError("messageId must contain 1-48 letters, digits, '_' or '-'.");
  const experienceTitle = typeof input.experienceTitle === "string" ? clippedTitle(input.experienceTitle) : "";
  if (!title(experienceTitle)) throw new StoreValidationError("experienceTitle must contain text.");
  if (!seats(input.seats)) throw new StoreValidationError(`seats must be an integer from 1 to ${SEATS_MAX}.`);
  const startsAt = canonicalInstant(input.startsAt);
  if (startsAt === null) throw new StoreValidationError("startsAt must be an ISO 8601 instant.");
  const payload: BookingMessagePayload = { v: 1, threadId: input.threadId, messageId: input.messageId, experienceTitle, startsAt, seats: input.seats };
  return insertRow(client, {
    providerId: input.providerId,
    bookingId: input.threadId,
    aggregateType: QUESTION_AGGREGATE_TYPE,
    topic: HOST_NOTIFICATION_TOPICS.bookingMessage,
    deduplicationKey: `host-push:booking-message:${input.messageId}`,
    payload,
    availableAt: null,
  });
}

/**
 * A guest booking made on this site was confirmed: one NEW_BOOKING notification (it cannot be turned
 * off), due now, and its email to each of the provider's OWNERs with an address here (#194, host-mail-shared.ts).
 * Called in the confirming transaction. 1 when the push was added, 0 for a repeat.
 */
export async function enqueueNewBookingNotification(client: PoolClient, input: BookingFacts): Promise<number> {
  const facts = { ...input, experienceTitle: typeof input.experienceTitle === "string" ? clippedTitle(input.experienceTitle) : "" };
  const { startsAt } = validBooking(facts);
  const payload: NewBookingPayload = { v: 1, bookingId: facts.bookingId, experienceTitle: facts.experienceTitle, startsAt, seats: facts.seats };
  const added = await insertRow(client, {
    providerId: facts.providerId,
    bookingId: facts.bookingId,
    topic: HOST_NOTIFICATION_TOPICS.newBooking,
    deduplicationKey: `host-push:new-booking:${facts.bookingId}`,
    payload,
    availableAt: null,
  });
  await enqueueHostBookingMails(client, {
    providerId: facts.providerId, topic: HOST_MAIL_TOPICS.newBooking, aggregateType: AGGREGATE_TYPE, aggregateId: facts.bookingId,
    deduplicationKey: `new-booking:${facts.bookingId}`, payload,
  });
  return added;
}

/**
 * A guest booking made on this site was cancelled by the guest or by NIHO support (#285 slice 7): one CANCELLATION
 * notification (it cannot be turned off), due now, and its email to each of the provider's OWNERs with an address here
 * (#194). Called in the cancelling transaction. 1 when the push was added, 0 for a repeat.
 */
export async function enqueueCancellationNotification(client: PoolClient, input: BookingFacts): Promise<number> {
  const facts = { ...input, experienceTitle: typeof input.experienceTitle === "string" ? clippedTitle(input.experienceTitle) : "" };
  const { startsAt } = validBooking(facts);
  const payload: CancellationPayload = { v: 1, bookingId: facts.bookingId, experienceTitle: facts.experienceTitle, startsAt, seats: facts.seats };
  const added = await insertRow(client, {
    providerId: facts.providerId,
    bookingId: facts.bookingId,
    topic: HOST_NOTIFICATION_TOPICS.cancellation,
    deduplicationKey: `host-push:cancellation:${facts.bookingId}`,
    payload,
    availableAt: null,
  });
  await enqueueHostBookingMails(client, {
    providerId: facts.providerId, topic: HOST_MAIL_TOPICS.cancellation, aggregateType: AGGREGATE_TYPE, aggregateId: facts.bookingId,
    deduplicationKey: `cancellation:${facts.bookingId}`, payload,
  });
  return added;
}

/**
 * A Google calendar input could not be read (#238): one GOOGLE_CALENDAR_ATTENTION notification (it cannot be turned off),
 * due now. A refused connection (`REVOKED`) is told once per connection generation, however many inputs it fails; reads
 * that keep failing (`UNAVAILABLE`) once per input and run of failures (`failingSinceUtc` is when the run began), so the
 * job's every retry adds nothing new. `inputId` is the resource ID (`RESOURCE`) or the provider ID (`PROVIDER`). Called in
 * the transaction that records the failure. 1 when added, 0 for a repeat.
 */
export async function enqueueGoogleCalendarAttentionNotification(
  client: PoolClient,
  input: {
    readonly providerId: string;
    readonly input: GoogleCalendarAttentionPayload["input"];
    readonly inputId: string;
    readonly reason: GoogleCalendarAttentionPayload["reason"];
    readonly connectionGeneration: number;
    readonly failingSinceUtc: string;
  },
): Promise<number> {
  assertStoreIdentifier(input.providerId, "providerId");
  if (input.input !== "PROVIDER" && input.input !== "RESOURCE") throw new StoreValidationError("input must be PROVIDER or RESOURCE.");
  if (input.reason !== "REVOKED" && input.reason !== "UNAVAILABLE") throw new StoreValidationError("reason must be REVOKED or UNAVAILABLE.");
  if (typeof input.inputId !== "string" || input.inputId.length < 1 || input.inputId.length > 256) throw new StoreValidationError("inputId must contain 1-256 characters.");
  if (!Number.isSafeInteger(input.connectionGeneration) || input.connectionGeneration < 1) throw new StoreValidationError("connectionGeneration must be a positive integer.");
  const since = canonicalInstant(input.failingSinceUtc);
  if (since === null) throw new StoreValidationError("failingSinceUtc must be an ISO 8601 instant.");
  const payload: GoogleCalendarAttentionPayload = { v: 1, input: input.input, reason: input.reason };
  // A digest keeps the key short and the resource ID out of it.
  const inputKey = createHash("sha256").update(`${input.input}\0${input.inputId}`).digest("hex").slice(0, 32);
  return insertRow(client, {
    providerId: input.providerId,
    bookingId: input.inputId,
    aggregateType: "google_calendar",
    topic: HOST_NOTIFICATION_TOPICS.googleCalendarAttention,
    deduplicationKey: input.reason === "REVOKED"
      ? `host-push:google-calendar:revoked:${input.connectionGeneration}`
      : `host-push:google-calendar:${inputKey}:${Date.parse(since)}`,
    payload,
    availableAt: null,
  });
}

/**
 * A booking on a reservation site was new, cancelled or moved (#194): one OTA_BOOKING notification per ledger revision
 * (NEW_BOOKING or CANCELLATION in 設定 › 通知, which cannot be turned off), due now. The push goes to the product's OWNER
 * and its operators only, and so does its email (one row each, for those with an address here; owner decision
 * 2026-11-01). The email row has no guest name: the mail job reads it when it sends. Called in the ledger's transaction.
 * 1 when the push was added, 0 for a repeat.
 */
export async function enqueueOtaBookingNotification(
  client: PoolClient,
  input: {
    readonly providerId: string;
    readonly change: OtaBookingChange;
    readonly site: string;
    readonly ref: string;
    /** The ledger revision this is about: one notification each. */
    readonly localRevision: number;
    readonly productId: string;
    readonly experienceTitle: string;
    readonly startsAt: string;
    readonly previousStartsAt?: string;
    readonly seats: number;
    readonly guestName?: string | null;
  },
): Promise<number> {
  assertStoreIdentifier(input.providerId, "providerId");
  if (!Number.isSafeInteger(input.localRevision) || input.localRevision < 1) throw new StoreValidationError("localRevision must be a positive integer.");
  const startsAt = canonicalInstant(input.startsAt);
  const previousStartsAt = input.previousStartsAt === undefined ? undefined : canonicalInstant(input.previousStartsAt);
  const payload = {
    v: 1, change: input.change, site: input.site, ref: input.ref, productId: input.productId,
    experienceTitle: typeof input.experienceTitle === "string" ? clippedTitle(input.experienceTitle) : "",
    startsAt, ...(input.change === "RESCHEDULED" ? { previousStartsAt } : {}), seats: input.seats,
    ...(typeof input.guestName === "string" ? { guestName: input.guestName } : {}),
  };
  // The same check the push job makes: a row it would drop is refused here instead.
  if (parseOtaBookingPayload(payload) === null) throw new StoreValidationError("The OTA booking notification is invalid.");
  const added = await insertRow(client, {
    providerId: input.providerId,
    bookingId: input.ref,
    aggregateType: "external_reservation",
    topic: HOST_NOTIFICATION_TOPICS.otaBooking,
    deduplicationKey: `host-push:ota-booking:${input.ref}:${input.localRevision}`,
    payload,
    availableAt: null,
  });
  const { guestName: _guestName, ...mailPayload } = payload;
  await enqueueHostBookingMails(client, {
    providerId: input.providerId, topic: HOST_MAIL_TOPICS.otaBooking, aggregateType: "external_reservation", aggregateId: input.ref,
    deduplicationKey: `ota-booking:${input.ref}:${input.localRevision}`, payload: mailPayload, productId: input.productId,
  });
  return added;
}

/**
 * Operations stopped a listing (`SUSPENDED`) or cleared that stop (`CLEARED`): one push per state change (設定 › 通知's
 * 掲載の運営停止・解除, which cannot be turned off), due now, to the product's OWNER and operators only. Called in the
 * transaction that changed the state, right after it, with the state's new version: a retry of the same change adds
 * nothing, and a change that fails or conflicts rolls this row back with it. A blank title becomes a fixed word rather
 * than failing the operation. 1 when added, 0 for a repeat.
 */
export async function enqueueListingSuspensionNotification(
  client: PoolClient,
  input: {
    readonly providerId: string;
    readonly productId: string;
    readonly experienceTitle: string | null;
    readonly change: ListingSuspensionChange;
    /** The publication state's version after the change. */
    readonly stateVersion: number;
  },
): Promise<number> {
  assertStoreIdentifier(input.providerId, "providerId");
  assertStoreIdentifier(input.productId, "productId");
  if (!Number.isSafeInteger(input.stateVersion) || input.stateVersion < 1) throw new StoreValidationError("stateVersion must be a positive integer.");
  const clipped = typeof input.experienceTitle === "string" ? clippedTitle(input.experienceTitle) : "";
  const payload: ListingSuspensionPayload = {
    v: 1, productId: input.productId, experienceTitle: clipped || LISTING_SUSPENSION_FALLBACK_TITLE, change: input.change,
  };
  // The same check the push job makes: a row it would drop is refused here instead.
  if (parseListingSuspensionPayload(payload) === null) throw new StoreValidationError("The listing suspension notification is invalid.");
  return insertRow(client, {
    providerId: input.providerId,
    bookingId: input.productId,
    aggregateType: "experience_product",
    topic: HOST_NOTIFICATION_TOPICS.listingSuspension,
    // A digest keeps the key within 256 characters however long the product ID is.
    deduplicationKey: `host-push:listing-suspension:${createHash("sha256").update(input.productId).digest("hex").slice(0, 32)}:${input.stateVersion}`,
    payload,
    availableAt: null,
  });
}

function assertRowId(id: string): void {
  if (!ROW_ID.test(id)) throw new StoreValidationError("id must be an outbox row id.");
}

function assertAttempts(attempts: number): void {
  if (!Number.isSafeInteger(attempts) || attempts < 0) throw new StoreValidationError("attempts must be the claim's attempt count.");
}

function claimedFromRow(row: DbRow): ClaimedHostNotification {
  const attempts = Number(row.attempts);
  if (typeof row.provider_id !== "string" || typeof row.topic !== "string" || !Number.isSafeInteger(attempts)) throw new StoreError("Database returned an invalid outbox row.");
  return { id: String(row.id), providerId: row.provider_id, topic: row.topic, payload: row.payload, attempts, createdAt: isoValue(row, "created_at") };
}

/** bigint ids as text, in numeric order. */
const byId = (a: ClaimedHostNotification, b: ClaimedHostNotification) => a.id.length - b.id.length || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The notification job's side of the host topics. There is no lease column: a claim moves
 * `available_at` past the lease, so a row the job never completes comes back by itself.
 */
export class HostNotificationOutbox {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  /**
   * Snapshot tomorrow's confirmed guest counts once per provider after 18:00 Japan time. The existing
   * push job calls this before draining; the unique date key makes concurrent and repeated runs safe.
   */
  async enqueueDueDayBeforeSummaries(now: Date): Promise<number> {
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new StoreValidationError("now must be a valid time.");
    const result = await this.#pool.query(
      `INSERT INTO outbox_messages (provider_id, aggregate_type, aggregate_id, topic, deduplication_key, payload, available_at)
       SELECT summary.provider_id, 'host_day_before_summary', summary.local_date, $2,
              'host-push:day-before-summary:' || summary.local_date,
              jsonb_build_object('v', 1, 'localDate', summary.local_date,
                'bookingCount', summary.booking_count, 'participantCount', summary.participant_count), $1::timestamptz
         FROM (
           SELECT b.provider_id, b.occurrence_snapshot->>'localDate' AS local_date,
                  count(*)::int AS booking_count, sum(g.adult_count + g.child_count)::int AS participant_count
             FROM bookings b
             JOIN booking_guests g ON g.provider_id = b.provider_id AND g.booking_id = b.id
            WHERE b.status = 'CONFIRMED'
              AND b.occurrence_snapshot->>'localDate' = (($1::timestamptz AT TIME ZONE 'Asia/Tokyo')::date + 1)::text
              AND ($1::timestamptz AT TIME ZONE 'Asia/Tokyo')::time >= time '18:00'
            GROUP BY b.provider_id, b.occurrence_snapshot->>'localDate'
         ) summary
       ON CONFLICT (provider_id, deduplication_key) DO NOTHING`,
      [now.toISOString(), HOST_NOTIFICATION_TOPICS.dayBeforeSummary],
    );
    return result.rowCount ?? 0;
  }

  /** Up to `limit` due rows, oldest first, each claimed for `leaseMs`. Concurrent claimers never share a row. */
  async claimDue(limit: number, leaseMs: number): Promise<ClaimedHostNotification[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new StoreValidationError("limit must be between 1 and 200.");
    if (!Number.isInteger(leaseMs) || leaseMs < 1_000 || leaseMs > HOUR_MS) throw new StoreValidationError("leaseMs must be between 1 second and 1 hour.");
    const result = await this.#pool.query<DbRow>(
      `UPDATE outbox_messages
          SET available_at = clock_timestamp() + $3::integer * interval '1 millisecond',
              attempts = attempts + 1
        WHERE id IN (
          SELECT id FROM outbox_messages
           WHERE processed_at IS NULL
             AND topic = ANY($1::text[])
             AND available_at <= clock_timestamp()
           ORDER BY available_at, id
           LIMIT $2
           FOR UPDATE SKIP LOCKED)
      RETURNING id::text AS id, provider_id, topic, payload, attempts, created_at`,
      [TOPICS, limit, leaseMs],
    );
    return result.rows.map(claimedFromRow).sort(byId);
  }

  /**
   * Sent, skipped or given up: the row is done. A row already closed (a cancelled reminder) stays as it is.
   * `attempts` is the claim's count: once the lease ran out and another run claimed the row again, this claim
   * no longer changes it. An OTA booking's row loses the guest's name here: it was only there for the push.
   */
  async complete(id: string, attempts: number): Promise<void> {
    assertRowId(id);
    assertAttempts(attempts);
    await this.#pool.query(
      `UPDATE outbox_messages SET processed_at = clock_timestamp(),
              payload = CASE WHEN topic = $4 THEN payload - 'guestName' ELSE payload END
        WHERE id = $1 AND topic = ANY($2::text[]) AND processed_at IS NULL AND attempts = $3`,
      [id, TOPICS, attempts, HOST_NOTIFICATION_TOPICS.otaBooking],
    );
  }

  /** Try again at `at` (instead of when the lease runs out), for the claim counted `attempts` only. */
  async retryAt(id: string, at: Date, attempts: number): Promise<void> {
    assertRowId(id);
    if (Number.isNaN(at.getTime())) throw new StoreValidationError("at must be a valid time.");
    assertAttempts(attempts);
    await this.#pool.query(
      "UPDATE outbox_messages SET available_at = $2 WHERE id = $1 AND topic = ANY($3::text[]) AND processed_at IS NULL AND attempts = $4",
      [id, at.toISOString(), TOPICS, attempts],
    );
  }
}
