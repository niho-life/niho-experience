import type { PoolClient } from "pg";
import { StoreAccessDeniedError, StoreError, StoreNotFoundError, StoreValidationError } from "./errors.ts";
import { calendarMembershipRole } from "./product-calendar-authorization.ts";
import { isoValue, type DbRow } from "./rows.ts";
import type { GuestCancellationPolicy, HostActor, PlatformFeeSnapshot } from "./types.ts";
import { assertCanonicalInstant, assertStoreIdentifier } from "./validation.ts";

/*
 * 予約 for bookings travelers made on this site (#285 slice 8, docs/guest-booking.md「ホストの画面」): what the
 * provider's OWNER reads of them. Read only: cancellation and refunds come with slice 7, messages with the
 * guest with slice 6. NIHO proves the account and its OWNER role; the experience DB checks its own OWNER
 * membership as well (ADR 0002), as 予約前の質問 and 設定 › 通知 do. The guest's email address is never
 * selected here: the host reaches the guest through NIHO. ホーム reads the sessions with guests and この回 one
 * session's bookings (slice 8b); the phone the store returns is for この回 only (owner decision 2026-10-22, #103).
 */

/** The statuses a host sees. A HOLD (checkout under way) or EXPIRED (abandoned) hold is not a booking. */
export const HOST_GUEST_BOOKING_STATUSES = ["CONFIRMED", "PAYMENT_REVIEW", "CANCELLED"] as const;
export type HostGuestBookingStatus = (typeof HOST_GUEST_BOOKING_STATUSES)[number];

export const HOST_GUEST_BOOKING_LIMITS = { listDefault: 50, listMax: 100 } as const;

/** One answer to the product's booking questions. */
export interface HostGuestBookingAnswer {
  readonly questionId: string;
  /**
   * The question as the product's sale terms word it now: the booking keeps the answer, not the question,
   * so a question reworded after the booking shows its new words. null once the terms dropped it.
   */
  readonly prompt: string | null;
  /** A text question's answer; null for a select question. */
  readonly text: string | null;
  /** A select question's choices: the label the terms give it now, null for an option they dropped. */
  readonly options: readonly { readonly id: string; readonly label: string | null }[];
}

/** The guest as they booked. Never their email address: the host reaches them through NIHO. */
export interface HostGuestBookingGuest {
  readonly name: string;
  /** For the day; null when they gave none. */
  readonly phone: string | null;
  readonly note: string | null;
  readonly answers: readonly HostGuestBookingAnswer[];
}

export interface HostGuestBooking {
  readonly publicBookingId: string;
  readonly productId: string;
  readonly productTitle: string;
  /** The schedule rule (the offer) the occurrence comes from. */
  readonly offerId: string;
  readonly status: HostGuestBookingStatus;
  /**
   * The occurrence as booked, in its own time zone: the snapshot. A host may have moved it before the
   * booking; an occurrence with bookings is not moved (saveOccurrenceOverride refuses).
   */
  readonly localDate: string;
  readonly localStartTime: string;
  readonly timeZone: string;
  readonly startUtc: string;
  readonly endUtc: string;
  readonly adultCount: number;
  readonly childCount: number;
  readonly language: "EN" | "JA";
  /** null once the guest's details were erased (a year after the experience, eraseGuestData). */
  readonly guest: HostGuestBookingGuest | null;
  readonly currency: string;
  /** Per seat, fixed at booking. */
  readonly adultUnitAmount: number;
  readonly childUnitAmount: number | null;
  /** What the guest paid. */
  readonly totalAmount: number;
  /** NIHO's fee fixed at booking; null only for a snapshot without one. */
  readonly platformFee: PlatformFeeSnapshot | null;
  /** The total less NIHO's fee: what the provider receives, before any refund. */
  readonly providerAmount: number;
  /** Fixed at booking; null only for a snapshot without one. */
  readonly cancellationPolicy: GuestCancellationPolicy | null;
  readonly bookedAtUtc: string;
  /** When the payment arrived (the confirmation, or the webhook event of one under review); null without one. */
  readonly paidAtUtc: string | null;
  readonly cancelledAtUtc: string | null;
}

export interface HostGuestBookingPage {
  /** Upcoming first (the nearest start first), then past (the latest first). */
  readonly bookings: readonly HostGuestBooking[];
  /** Pass back as `cursor` for the next page; null on the last one. */
  readonly nextCursor: string | null;
}

export interface HostGuestBookingListOptions {
  /** Where upcoming ends and past begins (canonical UTC; a start at it is upcoming). Now by default; a cursor keeps its first page's. */
  readonly from?: string;
  readonly cursor?: string | null;
  /** 1-100; 50 by default. */
  readonly limit?: number;
}

/**
 * One session with guests from this site (ホーム, #285 slice 8b): an offer of an experience on one day at one
 * time, as its bookings' occurrence snapshots name it. Those are 予約's session headings and この回's address
 * (`?date=&start=&experience=&offer=`), so the three screens agree on what a session is, also for an occurrence
 * a host moved before it was booked.
 */
export interface HostGuestSession {
  readonly productId: string;
  readonly productTitle: string;
  readonly offerId: string;
  /** YYYY-MM-DD and HH:MM in the occurrence's time zone. */
  readonly localDate: string;
  readonly localStartTime: string;
  readonly timeZone: string;
  readonly startUtc: string;
  readonly endUtc: string;
  /** The adults and children of its confirmed bookings and of its payments under review: who may come. */
  readonly participants: number;
  /** How many such bookings. */
  readonly bookings: number;
  /** How many of them are payments under review (確認待ち): they keep no seat. */
  readonly paymentReviews: number;
}

export interface HostGuestSessionListOptions {
  /** Sessions starting at it or later (canonical UTC). Now by default. */
  readonly from?: string;
  /** Sessions starting before it (canonical UTC, after `from`). No end by default. */
  readonly to?: string;
  /** 1-100; 50 by default. */
  readonly limit?: number;
}

/** One session as この回's address names it: the experience, the offer, and the snapshot's local day and start. */
export interface HostGuestSessionKey {
  readonly productId: string;
  readonly offerId: string;
  readonly localDate: string;
  readonly localStartTime: string;
}

type Segment = "UPCOMING" | "PAST";
interface Cursor {
  readonly from: string;
  readonly segment: Segment;
  /** The last row of the previous page in this segment; null at the segment's start. */
  readonly after: { readonly startUtc: string; readonly id: string } | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const POLICIES: ReadonlySet<string> = new Set(["FREE_UNTIL_24H", "FREE_UNTIL_48H", "NONE"]);
const START = "(b.occurrence_snapshot->>'startUtc')::timestamptz";
/** A session as the snapshot names it (HostGuestSession). */
const RULE = "(b.occurrence_snapshot->>'ruleId')";
const LOCAL_DATE = "(b.occurrence_snapshot->>'localDate')";
const LOCAL_START = "(b.occurrence_snapshot->>'localStartTime')";
/** Who may come to a session: a payment under review keeps no seat, but the guest paid and may come. Never a cancellation. */
const SESSION_GUEST_STATUSES = ["CONFIRMED", "PAYMENT_REVIEW"] as const;
const LOCAL_DATE_FORMAT = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_TIME_FORMAT = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A current OWNER, not capped below OWNER by NIHO and not a product operator (as 予約前の質問). */
export async function requireBookingsOwner(client: PoolClient, actor: HostActor): Promise<void> {
  assertStoreIdentifier(actor.providerId, "actor.providerId");
  assertStoreIdentifier(actor.nihoUserId, "actor.nihoUserId");
  if (await calendarMembershipRole(client, actor, ["OWNER"]) !== "OWNER") throw new StoreAccessDeniedError();
}

export function publicBookingIdOf(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new StoreValidationError("publicBookingId must be a UUID.");
  return value.toLowerCase();
}

export function listLimit(value: unknown): number {
  const limit = value ?? HOST_GUEST_BOOKING_LIMITS.listDefault;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > HOST_GUEST_BOOKING_LIMITS.listMax) {
    throw new StoreValidationError(`limit must be an integer from 1 to ${HOST_GUEST_BOOKING_LIMITS.listMax}.`);
  }
  return limit;
}

function instant(value: unknown, path: string): string {
  if (typeof value !== "string") throw new StoreValidationError(`${path} must be a canonical UTC instant.`);
  assertCanonicalInstant(value, path);
  return value;
}

export function encodeBookingCursor(cursor: Cursor): string {
  const after = cursor.after ? [cursor.after.startUtc, cursor.after.id] : [];
  return Buffer.from(JSON.stringify([cursor.from, cursor.segment, ...after]), "utf8").toString("base64url");
}

export function decodeBookingCursor(cursor: unknown): Cursor | null {
  if (cursor === undefined || cursor === null) return null;
  if (typeof cursor !== "string" || cursor.length > 300) throw new StoreValidationError("cursor is invalid.");
  try {
    const parts: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!Array.isArray(parts) || (parts.length !== 2 && parts.length !== 4)) throw new Error("shape");
    const [from, segment, startUtc, id] = parts as unknown[];
    if (segment !== "UPCOMING" && segment !== "PAST") throw new Error("segment");
    if (parts.length === 2) return { from: instant(from, "cursor"), segment, after: null };
    if (typeof id !== "string" || !UUID.test(id)) throw new Error("id");
    return { from: instant(from, "cursor"), segment, after: { startUtc: instant(startUtc, "cursor"), id: id.toLowerCase() } };
  } catch {
    throw new StoreValidationError("cursor is invalid.");
  }
}

/** Defaults to the database's clock, so the boundary is the same instant the rest of the store calls now. */
export async function listBoundary(client: PoolClient, from: unknown): Promise<string> {
  if (from !== undefined) return instant(from, "from");
  const result = await client.query<DbRow>("SELECT clock_timestamp() AS now");
  return isoValue(result.rows[0]!, "now");
}

/**
 * Everything the host sees of the provider's guest bookings, one row each: never `guest_email` or
 * `guest_email_key`. The current sale terms name the answered questions.
 */
const SELECT_HOST_BOOKINGS = `
  SELECT b.public_booking_id::text AS public_booking_id, b.product_id, p.public_title, b.status,
         b.occurrence_snapshot, b.pricing_snapshot, b.created_at, b.cancelled_at,
         COALESCE(b.confirmed_at, (
           SELECT min(e.occurred_at) FROM stripe_webhook_events e
            WHERE e.provider_id = b.provider_id AND e.booking_id = b.id AND e.outcome IN ('CONFIRMED', 'PAYMENT_REVIEW')
         )) AS paid_at,
         g.guest_name, g.guest_phone, g.note, g.answers, g.guest_language, g.adult_count, g.child_count,
         g.pii_erased_at IS NOT NULL AS erased, t.booking_questions
    FROM bookings b
    JOIN booking_guests g ON g.provider_id = b.provider_id AND g.booking_id = b.id
    JOIN experience_products p ON p.provider_id = b.provider_id AND p.id = b.product_id
    LEFT JOIN experience_product_sale_terms t ON t.provider_id = b.provider_id AND t.product_id = b.product_id
   WHERE b.provider_id = $1 AND b.status = ANY($2::text[])`;

/** One segment of the list, after the cursor's row when it is in this segment. */
export async function selectSegment(client: PoolClient, providerId: string, segment: Segment, from: string, after: Cursor["after"], limit: number): Promise<DbRow[]> {
  const upcoming = segment === "UPCOMING";
  const result = await client.query<DbRow>(
    `${SELECT_HOST_BOOKINGS}
       AND ${START} ${upcoming ? ">=" : "<"} $3::timestamptz
       AND ($4::timestamptz IS NULL OR (${START}, b.public_booking_id) ${upcoming ? ">" : "<"} ($4::timestamptz, $5::uuid))
     ORDER BY ${START} ${upcoming ? "ASC" : "DESC"}, b.public_booking_id ${upcoming ? "ASC" : "DESC"}
     LIMIT $6`,
    [providerId, HOST_GUEST_BOOKING_STATUSES, from, after?.startUtc ?? null, after?.id ?? null, limit],
  );
  return result.rows;
}

export async function selectOne(client: PoolClient, providerId: string, publicBookingId: string): Promise<DbRow> {
  const result = await client.query<DbRow>(`${SELECT_HOST_BOOKINGS} AND b.public_booking_id = $3::uuid`, [providerId, HOST_GUEST_BOOKING_STATUSES, publicBookingId]);
  const row = result.rows[0];
  if (row === undefined) throw new StoreNotFoundError("guest booking");
  return row;
}

export async function countShown(client: PoolClient, providerId: string): Promise<number> {
  const result = await client.query<DbRow>(
    `SELECT count(*)::int AS n FROM bookings b JOIN booking_guests g ON g.provider_id = b.provider_id AND g.booking_id = b.id
      WHERE b.provider_id = $1 AND b.status = ANY($2::text[])`,
    [providerId, HOST_GUEST_BOOKING_STATUSES],
  );
  return Number(result.rows[0]!.n);
}

/** `to` of listGuestSessionsForHost: a canonical instant, or null without one. Checked against `from` once that is known. */
export function sessionWindowEnd(value: unknown): string | null {
  return value === undefined ? null : instant(value, "to");
}

export function assertSessionWindow(from: string, to: string | null): void {
  if (to !== null && Date.parse(to) <= Date.parse(from)) throw new StoreValidationError("to must be after from.");
}

/** この回's address as the store reads it: identifiers, a YYYY-MM-DD day and an HH:MM start. */
export function sessionKeyOf(value: unknown): HostGuestSessionKey {
  const { productId, offerId, localDate, localStartTime } = record(value);
  if (typeof productId !== "string" || typeof offerId !== "string") throw new StoreValidationError("productId and offerId must be identifiers.");
  assertStoreIdentifier(productId, "productId");
  assertStoreIdentifier(offerId, "offerId");
  if (typeof localDate !== "string" || !LOCAL_DATE_FORMAT.test(localDate)) throw new StoreValidationError("localDate must be YYYY-MM-DD.");
  if (typeof localStartTime !== "string" || !LOCAL_TIME_FORMAT.test(localStartTime)) throw new StoreValidationError("localStartTime must be HH:MM.");
  return { productId, offerId, localDate, localStartTime };
}

/**
 * The provider's sessions with guests from this site starting in [from, to), the nearest first: one row per
 * experience, offer, day and start of the snapshots. Never a guest's name or contact: only counts.
 */
export async function selectSessions(client: PoolClient, providerId: string, from: string, to: string | null, limit: number): Promise<DbRow[]> {
  const result = await client.query<DbRow>(
    `SELECT b.product_id, p.public_title, ${RULE} AS rule_id, ${LOCAL_DATE} AS local_date, ${LOCAL_START} AS local_start_time,
            min(b.occurrence_snapshot->>'timeZone') AS time_zone, min(${START}) AS start_utc,
            max((b.occurrence_snapshot->>'endUtc')::timestamptz) AS end_utc,
            sum(g.adult_count + g.child_count)::int AS participants, count(*)::int AS bookings,
            (count(*) FILTER (WHERE b.status = 'PAYMENT_REVIEW'))::int AS payment_reviews
       FROM bookings b
       JOIN booking_guests g ON g.provider_id = b.provider_id AND g.booking_id = b.id
       JOIN experience_products p ON p.provider_id = b.provider_id AND p.id = b.product_id
      WHERE b.provider_id = $1 AND b.status = ANY($2::text[])
        AND ${START} >= $3::timestamptz AND ($4::timestamptz IS NULL OR ${START} < $4::timestamptz)
      GROUP BY b.product_id, p.public_title, ${RULE}, ${LOCAL_DATE}, ${LOCAL_START}
      ORDER BY min(${START}), b.product_id, ${RULE}
      LIMIT $5`,
    [providerId, SESSION_GUEST_STATUSES, from, to, limit],
  );
  return result.rows;
}

/** Every booking a host sees of one session (confirmed, under review, cancelled), in the order they were made. */
export async function selectSessionBookings(client: PoolClient, providerId: string, key: HostGuestSessionKey): Promise<DbRow[]> {
  const result = await client.query<DbRow>(
    `${SELECT_HOST_BOOKINGS}
       AND b.product_id = $3 AND ${RULE} = $4 AND ${LOCAL_DATE} = $5 AND ${LOCAL_START} = $6
     ORDER BY b.created_at, b.public_booking_id`,
    [providerId, HOST_GUEST_BOOKING_STATUSES, key.productId, key.offerId, key.localDate, key.localStartTime],
  );
  return result.rows;
}

/** The next page's cursor: after the page's last row, or at the start of the past once the upcoming ran out. */
export function cursorAfter(from: string, segment: Segment, row: DbRow | null): string {
  return encodeBookingCursor({ from, segment, after: row ? { startUtc: startOf(row), id: String(row.public_booking_id) } : null });
}

/* ---------- rows ---------- */

const record = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {});

function text(value: unknown, key: string): string {
  if (typeof value !== "string" || value.length === 0) throw new StoreError(`Database returned an invalid ${key}.`);
  return value;
}

function amount(value: unknown, key: string): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new StoreError(`Database returned an invalid ${key}.`);
  return parsed;
}

function startOf(row: DbRow): string {
  return text(record(row.occurrence_snapshot).startUtc, "occurrence_snapshot.startUtc");
}

/** The terms' questions by id, read leniently: a question or option the terms no longer have reads as null. */
function questionsById(value: unknown): Map<string, { prompt: string | null; options: Map<string, string> }> {
  const questions = new Map<string, { prompt: string | null; options: Map<string, string> }>();
  if (!Array.isArray(value)) return questions;
  for (const raw of value) {
    const question = record(raw);
    if (typeof question.id !== "string") continue;
    const options = new Map<string, string>();
    for (const option of Array.isArray(question.options) ? question.options : []) {
      const { id, label } = record(option);
      if (typeof id === "string" && typeof label === "string") options.set(id, label);
    }
    questions.set(question.id, { prompt: typeof question.prompt === "string" ? question.prompt : null, options });
  }
  return questions;
}

function answersOf(stored: unknown, terms: unknown): HostGuestBookingAnswer[] {
  if (!Array.isArray(stored)) return [];
  const questions = questionsById(terms);
  return stored.map((raw): HostGuestBookingAnswer => {
    const answer = record(raw);
    const questionId = text(answer.questionId, "answers.questionId");
    const question = questions.get(questionId);
    const optionIds = Array.isArray(answer.optionIds) ? answer.optionIds.filter((id): id is string => typeof id === "string") : [];
    return {
      questionId,
      prompt: question?.prompt ?? null,
      text: typeof answer.text === "string" ? answer.text : null,
      options: optionIds.map((id) => ({ id, label: question?.options.get(id) ?? null })),
    };
  });
}

function platformFeeOf(value: unknown): PlatformFeeSnapshot | null {
  const fee = record(value);
  if (typeof fee.supportEnabled !== "boolean" || (fee.basisPoints !== 1000 && fee.basisPoints !== 1500)) return null;
  return { supportEnabled: fee.supportEnabled, basisPoints: fee.basisPoints, amount: amount(fee.amount, "pricing_snapshot.platformFee.amount") };
}

const optionalIso = (row: DbRow, key: string): string | null => (row[key] === null || row[key] === undefined ? null : isoValue(row, key));
const optionalText = (value: unknown): string | null => (typeof value === "string" ? value : null);

export function hostGuestSessionFromRow(row: DbRow): HostGuestSession {
  return {
    productId: text(row.product_id, "product_id"),
    productTitle: text(row.public_title, "public_title"),
    offerId: text(row.rule_id, "occurrence_snapshot.ruleId"),
    localDate: text(row.local_date, "occurrence_snapshot.localDate"),
    localStartTime: text(row.local_start_time, "occurrence_snapshot.localStartTime"),
    timeZone: text(row.time_zone, "occurrence_snapshot.timeZone"),
    startUtc: isoValue(row, "start_utc"),
    endUtc: isoValue(row, "end_utc"),
    participants: amount(row.participants, "participants"),
    bookings: amount(row.bookings, "bookings"),
    paymentReviews: amount(row.payment_reviews, "payment_reviews"),
  };
}

export function hostGuestBookingFromRow(row: DbRow): HostGuestBooking {
  const occurrence = record(row.occurrence_snapshot);
  const pricing = record(row.pricing_snapshot);
  const breakdown = record(pricing.breakdown);
  const totalAmount = amount(pricing.totalAmount, "pricing_snapshot.totalAmount");
  const platformFee = platformFeeOf(pricing.platformFee);
  const policy = pricing.cancellationPolicy;
  const erased = row.erased === true;
  return {
    publicBookingId: text(row.public_booking_id, "public_booking_id"),
    productId: text(row.product_id, "product_id"),
    productTitle: text(row.public_title, "public_title"),
    offerId: text(occurrence.ruleId, "occurrence_snapshot.ruleId"),
    status: text(row.status, "status") as HostGuestBookingStatus,
    localDate: text(occurrence.localDate, "occurrence_snapshot.localDate"),
    localStartTime: text(occurrence.localStartTime, "occurrence_snapshot.localStartTime"),
    timeZone: text(occurrence.timeZone, "occurrence_snapshot.timeZone"),
    startUtc: startOf(row),
    endUtc: text(occurrence.endUtc, "occurrence_snapshot.endUtc"),
    adultCount: amount(row.adult_count, "adult_count"),
    childCount: amount(row.child_count, "child_count"),
    language: row.guest_language === "JA" ? "JA" : "EN",
    guest: erased ? null : {
      name: text(row.guest_name, "guest_name"),
      phone: optionalText(row.guest_phone),
      note: optionalText(row.note),
      answers: answersOf(row.answers, row.booking_questions),
    },
    currency: text(pricing.currency, "pricing_snapshot.currency"),
    adultUnitAmount: amount(pricing.unitAmount, "pricing_snapshot.unitAmount"),
    childUnitAmount: breakdown.childUnitAmount === null || breakdown.childUnitAmount === undefined ? null : amount(breakdown.childUnitAmount, "pricing_snapshot.breakdown.childUnitAmount"),
    totalAmount,
    platformFee,
    providerAmount: totalAmount - (platformFee?.amount ?? 0),
    cancellationPolicy: typeof policy === "string" && POLICIES.has(policy) ? policy as GuestCancellationPolicy : null,
    bookedAtUtc: isoValue(row, "created_at"),
    paidAtUtc: optionalIso(row, "paid_at"),
    cancelledAtUtc: optionalIso(row, "cancelled_at"),
  };
}
