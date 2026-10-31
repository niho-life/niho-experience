import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { StoreConflictError, StoreNotFoundError, StoreValidationError } from "./errors.ts";
import { requireOwner } from "./guest-questions.ts";
import { isoValue, type DbRow } from "./rows.ts";
import { withTransaction } from "./transaction.ts";
import type { HostActor } from "./types.ts";
import { assertStoreIdentifier } from "./validation.ts";

/** よかった点: the identifiers migration 0027 accepts, in the order counts and pages list them. `label` is the public wording. */
export const GUEST_REVIEW_TAGS = [
  { value: "CALM_ATMOSPHERE", label: "Calm atmosphere" },
  { value: "GOOD_FOR_BEGINNERS", label: "Good for beginners" },
  { value: "EASY_TO_FIND", label: "Easy to find" },
  { value: "GREAT_HOST", label: "Great host" },
  { value: "GOOD_VALUE", label: "Good value" },
] as const;
export type GuestReviewTagValue = (typeof GUEST_REVIEW_TAGS)[number]["value"];

/** Why the host reports a review to NIHO: 個人情報 / 事実と違う / 不適切 / その他. */
export const GUEST_REVIEW_REPORT_REASONS = ["PERSONAL", "UNTRUE", "INAPPROPRIATE", "OTHER"] as const;
export type GuestReviewReportReason = (typeof GUEST_REVIEW_REPORT_REASONS)[number];
export type GuestReviewLanguage = "EN" | "JA";

/**
 * The bounds migration 0027 keeps. The public ones match REVIEW_LIMITS (packages/api-client/src/journey.ts).
 * submitWindowDays (a review is taken until this many days after the session ends) is niho-app#19314's
 * recommendation, not yet confirmed by the owner.
 */
export const GUEST_REVIEW_LIMITS = {
  bodyMaxLength: 2000,
  replyMaxLength: 2000,
  displayNameMaxLength: 60,
  noteMaxLength: 500,
  reportNoteMaxLength: 500,
  publicListMax: 50,
  hostListMax: 100,
  submitWindowDays: 30,
  invitationTtlDaysMax: 30,
} as const;

/** Whether the guest of a booking that ended may review it, beyond what the store checks itself. */
export type GuestReviewEligibility = (booking: { readonly providerId: string; readonly bookingId: string; readonly endUtc: string }) => Promise<boolean>;

export interface SubmitGuestReviewInput {
  /** 1-5. */
  readonly rating: number;
  readonly body: string;
  /** GUEST_REVIEW_TAGS identifiers; duplicates are dropped. */
  readonly tags?: readonly string[];
  /** The name shown with the review, as the guest wants it (one line, no email address). */
  readonly displayName: string;
  readonly originLabel?: string | null;
  /** あなただけへのメモ: for the host only. */
  readonly noteToHost?: string | null;
  /** The language the guest wrote in; EN when not given. */
  readonly language?: GuestReviewLanguage;
  /** The page's key for this review: the same key again is the same review. */
  readonly clientRequestKey: string;
}

/** What the review page shows to whoever holds the link. Never the guest's details or the booking's identifiers. */
export interface GuestReviewInvitation {
  readonly experienceTitle: string;
  readonly hostDisplayName: string;
  readonly sessionStartUtc: string;
  readonly expiresAtUtc: string;
}

/** One published review, in the shape of ExperienceReview (packages/api-client/src/journey.ts). */
export type PublicGuestReview = {
  id: string;
  rating: 1 | 2 | 3 | 4 | 5;
  body: string;
  /** Labels, in GUEST_REVIEW_TAGS order. */
  tags: string[];
  displayName: string;
  originLabel: string | null;
  publishedAt: string;
  fromBooking: true;
  reply: { hostName: string; body: string } | null;
};

/** The shape of ExperienceReviewsResponse: the summary counts every published review, whatever the limit. */
export type PublicGuestReviews = {
  summary: { count: number; average: number | null; tags: { label: string; count: number }[] };
  reviews: PublicGuestReview[];
};

/** A review as レビュー shows it to the OWNER. Never the guest's email, phone or booking name. */
export interface HostGuestReview {
  readonly id: string;
  readonly productId: string;
  readonly productTitle: string;
  readonly bookingPublicId: string;
  readonly sessionStartUtc: string;
  readonly reviewerName: string;
  readonly reviewerOrigin: string | null;
  readonly rating: number;
  readonly tags: readonly GuestReviewTagValue[];
  readonly body: string;
  /** The Japanese translation; null until one is made. */
  readonly bodyJa: string | null;
  readonly language: GuestReviewLanguage;
  readonly noteToHost: string | null;
  readonly submittedAtUtc: string;
  readonly status: "PENDING" | "PUBLISHED";
  readonly publishedAtUtc: string | null;
  readonly reply: {
    readonly english: string;
    /** The Japanese the host wrote, or null when they wrote the English directly. */
    readonly japanese: string | null;
    readonly repliedAtUtc: string;
    readonly editedAtUtc: string | null;
    /** Pass back as `expectedRevision` to correct it. */
    readonly revision: number;
  } | null;
  readonly report: { readonly reason: GuestReviewReportReason; readonly note: string | null; readonly reportedAtUtc: string } | null;
}

export interface HostGuestReviewPage {
  readonly reviews: readonly HostGuestReview[];
  /** Pass back as `cursor` for the next page; null on the last one. */
  readonly nextCursor: string | null;
}

const RECEIVED = { status: "received" } as const;
const TAG_LABELS: ReadonlyMap<string, string> = new Map(GUEST_REVIEW_TAGS.map((tag) => [tag.value, tag.label]));
const REASONS: ReadonlySet<string> = new Set(GUEST_REVIEW_REPORT_REASONS);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const REQUEST_KEY = /^[A-Za-z0-9._:-]{8,120}$/;
const BOOKING_ID = /^[1-9][0-9]{0,18}$/;
/** Control characters other than tab and line breaks. */
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
/** Any control character: a one-line field has none after folding. */
const LINE_CONTROL = /[\u0000-\u001F\u007F-\u009F]/;
const CURSOR = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)\|([0-9a-f-]{36})$/i;

/** The booking's end; b is the bookings row. */
const ENDED_AT = "(b.occurrence_snapshot->>'endUtc')::timestamptz";
/** Confirmed, over, and still within the window after its end. */
const REVIEWABLE = `(b.status = 'CONFIRMED' AND ${ENDED_AT} <= clock_timestamp()
  AND ${ENDED_AT} + make_interval(days => ${GUEST_REVIEW_LIMITS.submitWindowDays}) > clock_timestamp())`;
const REVIEWED = "EXISTS (SELECT 1 FROM guest_reviews g WHERE g.provider_id = b.provider_id AND g.booking_id = b.id)";

function uuid(value: unknown, path: string): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new StoreValidationError(`${path} must be a UUID.`);
  return value.toLowerCase();
}

function text(value: unknown, path: string, min: number, max: number): string {
  if (typeof value !== "string" || CONTROL.test(value)) throw new StoreValidationError(`${path} must be text.`);
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) throw new StoreValidationError(`${path} must contain ${min}-${max} characters.`);
  return trimmed;
}

/** Null when not given or blank. */
function optionalText(value: unknown, path: string, max: number): string | null {
  if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) return null;
  return text(value, path, 1, max);
}

/** One line: runs of spaces and line breaks become one space. */
function line(value: unknown, path: string, max: number): string {
  const folded = typeof value === "string" ? value.replace(/\s+/g, " ") : value;
  if (typeof folded === "string" && LINE_CONTROL.test(folded)) throw new StoreValidationError(`${path} must be text.`);
  return text(folded, path, 1, max);
}

function requestKey(value: unknown, path: string): string {
  if (typeof value !== "string" || !REQUEST_KEY.test(value)) throw new StoreValidationError(`${path} must be 8-120 letters, digits or ._:-`);
  return value;
}

function boundedInteger(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new StoreValidationError(`${path} must be an integer from ${min} to ${max}.`);
  return value;
}

function bookingRowId(value: unknown): string {
  if (typeof value !== "string" || !BOOKING_ID.test(value) || BigInt(value) > 9223372036854775807n) throw new StoreValidationError("bookingId must be a booking row id.");
  return value;
}

function tokenDigest(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23505";
}

function nullable(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

interface ValidReview {
  rating: number;
  body: string;
  tags: GuestReviewTagValue[];
  displayName: string;
  originLabel: string | null;
  noteToHost: string | null;
  language: GuestReviewLanguage;
  clientRequestKey: string;
}

function validReview(input: SubmitGuestReviewInput): ValidReview {
  if (input === null || typeof input !== "object") throw new StoreValidationError("review must be an object.");
  const rating = boundedInteger(input.rating, "rating", 1, 5);
  const language = input.language ?? "EN";
  if (language !== "EN" && language !== "JA") throw new StoreValidationError("language must be EN or JA.");
  const tags = input.tags ?? [];
  if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== "string" || !TAG_LABELS.has(tag))) throw new StoreValidationError("tags must be known tags.");
  const displayName = line(input.displayName, "displayName", GUEST_REVIEW_LIMITS.displayNameMaxLength);
  if (displayName.includes("@")) throw new StoreValidationError("displayName must not be an email address.");
  const origin = input.originLabel;
  return {
    rating,
    body: text(input.body, "body", 1, GUEST_REVIEW_LIMITS.bodyMaxLength),
    // Each tag once, in GUEST_REVIEW_TAGS order.
    tags: GUEST_REVIEW_TAGS.filter((tag) => tags.includes(tag.value)).map((tag) => tag.value),
    displayName,
    originLabel: origin === null || origin === undefined || (typeof origin === "string" && origin.trim() === "")
      ? null
      : line(origin, "originLabel", GUEST_REVIEW_LIMITS.displayNameMaxLength),
    noteToHost: optionalText(input.noteToHost, "noteToHost", GUEST_REVIEW_LIMITS.noteMaxLength),
    language,
    clientRequestKey: requestKey(input.clientRequestKey, "clientRequestKey"),
  };
}

/** At most `max` UTF-16 units (the api-client's measure), never splitting a character. */
function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  let clipped = "";
  for (const character of value) {
    if (clipped.length + character.length > max) break;
    clipped += character;
  }
  return clipped;
}

const HOST_COLUMNS = `r.id, r.product_id, p.public_title, b.public_booking_id, (b.occurrence_snapshot->>'startUtc')::timestamptz AS session_start_at,
  r.display_name, r.origin_label, r.rating, r.tags, r.body, r.body_ja, r.language, r.note_to_host, r.submitted_at, r.status, r.published_at,
  r.reply_body, r.reply_body_ja, r.replied_at, r.reply_edited_at, r.reply_revision, r.report_reason, r.report_note, r.reported_at,
  to_char(r.submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at`;
const HOST_FROM = `guest_reviews r
  JOIN experience_products p ON p.provider_id = r.provider_id AND p.id = r.product_id
  JOIN bookings b ON b.provider_id = r.provider_id AND b.id = r.booking_id`;

function hostReviewFromRow(row: DbRow): HostGuestReview {
  const reply = row.reply_body === null || row.reply_body === undefined ? null : {
    english: String(row.reply_body),
    japanese: nullable(row.reply_body_ja),
    repliedAtUtc: isoValue(row, "replied_at"),
    editedAtUtc: row.reply_edited_at === null || row.reply_edited_at === undefined ? null : isoValue(row, "reply_edited_at"),
    revision: Number(row.reply_revision),
  };
  const report = row.report_reason === null || row.report_reason === undefined ? null : {
    reason: String(row.report_reason) as GuestReviewReportReason,
    note: nullable(row.report_note),
    reportedAtUtc: isoValue(row, "reported_at"),
  };
  return {
    id: String(row.id),
    productId: String(row.product_id),
    productTitle: String(row.public_title),
    bookingPublicId: String(row.public_booking_id),
    sessionStartUtc: isoValue(row, "session_start_at"),
    reviewerName: String(row.display_name),
    reviewerOrigin: nullable(row.origin_label),
    rating: Number(row.rating),
    tags: (Array.isArray(row.tags) ? row.tags : []).filter((tag): tag is GuestReviewTagValue => TAG_LABELS.has(String(tag))),
    body: String(row.body),
    bodyJa: nullable(row.body_ja),
    language: String(row.language) as GuestReviewLanguage,
    noteToHost: nullable(row.note_to_host),
    submittedAtUtc: isoValue(row, "submitted_at"),
    status: String(row.status) as HostGuestReview["status"],
    publishedAtUtc: row.published_at === null || row.published_at === undefined ? null : isoValue(row, "published_at"),
    reply,
    report,
  };
}

async function hostReview(client: PoolClient, providerId: string, reviewId: string): Promise<HostGuestReview> {
  const result = await client.query<DbRow>(
    `SELECT ${HOST_COLUMNS} FROM ${HOST_FROM} WHERE r.provider_id = $1 AND r.id = $2::uuid AND r.status IN ('PENDING', 'PUBLISHED')`,
    [providerId, reviewId],
  );
  if (!result.rows[0]) throw new StoreNotFoundError("guest review");
  return hostReviewFromRow(result.rows[0]);
}

function encodeCursor(row: DbRow): string {
  return Buffer.from(`${String(row.cursor_at)}|${String(row.id)}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: unknown): { at: string; id: string } | null {
  if (cursor === undefined || cursor === null) return null;
  if (typeof cursor !== "string" || cursor.length > 200) throw new StoreValidationError("cursor is invalid.");
  const match = CURSOR.exec(Buffer.from(cursor, "base64url").toString("utf8"));
  if (!match || !UUID.test(match[2]!)) throw new StoreValidationError("cursor is invalid.");
  return { at: match[1]!, id: match[2]!.toLowerCase() };
}

/**
 * 予約者のレビュー (#104, #108; migration 0027). The review page has no identity: it holds a one-time link
 * that the thank-you email (next slice) gets from `issueInvitation`. The experience page reads published
 * reviews by slug. The host's methods need a current OWNER of the provider. NIHO publishes and hides reviews;
 * this class never does. No guest email, phone or booking name is read here.
 */
export class GuestReviewRepository {
  readonly #pool: Pool;
  readonly #eligibility: GuestReviewEligibility;

  constructor(pool: Pool, options: { eligibility?: GuestReviewEligibility } = {}) {
    this.#pool = pool;
    // TODO(#104 #108): once attendance is recorded, plug the check that leaves out NO_SHOW bookings in here.
    // Whether an unrecorded booking counts as attended is the owner's call (niho-app#19314 recommends it does).
    this.#eligibility = options.eligibility ?? (async () => true);
  }

  /* ---------- the review link (server-side, for the thank-you email) ---------- */

  /**
   * A one-time link to review a confirmed booking whose session ended at most submitWindowDays ago, valid for
   * `ttlDays`. Only its SHA-256 is stored. StoreNotFoundError when the booking is unknown or may not be
   * reviewed; StoreConflictError when it already has a review.
   */
  async issueInvitation(input: { providerId: string; bookingId: string; ttlDays: number }): Promise<{ token: string; expiresAtUtc: string }> {
    if (input === null || typeof input !== "object") throw new StoreValidationError("invitation must be an object.");
    assertStoreIdentifier(input.providerId, "providerId");
    const bookingId = bookingRowId(input.bookingId);
    const ttlDays = boundedInteger(input.ttlDays, "ttlDays", 1, GUEST_REVIEW_LIMITS.invitationTtlDaysMax);
    return withTransaction(this.#pool, async (client) => {
      const found = await client.query<DbRow>(
        `SELECT ${ENDED_AT} AS end_at, ${REVIEWABLE} AS reviewable, ${REVIEWED} AS reviewed
           FROM bookings b WHERE b.provider_id = $1 AND b.id = $2::bigint`,
        [input.providerId, bookingId],
      );
      const booking = found.rows[0];
      if (!booking || booking.reviewable !== true) throw new StoreNotFoundError("reviewable booking");
      if (booking.reviewed === true) throw new StoreConflictError("The booking already has a review.");
      if (!(await this.#eligibility({ providerId: input.providerId, bookingId, endUtc: isoValue(booking, "end_at") }))) throw new StoreNotFoundError("reviewable booking");
      const token = randomBytes(32).toString("base64url");
      const link = await client.query<DbRow>(
        `WITH now AS (SELECT clock_timestamp() AS at)
         INSERT INTO guest_review_invitations (token_hash, provider_id, booking_id, expires_at, created_at)
         SELECT $1, $2, $3::bigint, now.at + make_interval(days => $4), now.at FROM now
         RETURNING expires_at`,
        [tokenDigest(token), input.providerId, bookingId, ttlDays],
      );
      return { token, expiresAtUtc: isoValue(link.rows[0]!, "expires_at") };
    });
  }

  /* ---------- the guest's review page (one-time link) ---------- */

  /** What the link is for; null when it is unknown, expired or used, or its booking may no longer be reviewed. */
  async openInvitation(token: string): Promise<GuestReviewInvitation | null> {
    if (typeof token !== "string" || !TOKEN.test(token)) return null;
    const found = await this.#pool.query<DbRow>(
      `SELECT i.provider_id, i.booking_id::text AS booking_id, i.expires_at, i.used_at, i.expires_at > clock_timestamp() AS open,
              ${ENDED_AT} AS end_at, (b.occurrence_snapshot->>'startUtc')::timestamptz AS start_at,
              ${REVIEWABLE} AS reviewable, ${REVIEWED} AS reviewed, p.public_title, p.seller_display_name
         FROM guest_review_invitations i
         JOIN bookings b ON b.provider_id = i.provider_id AND b.id = i.booking_id
         JOIN experience_products p ON p.provider_id = b.provider_id AND p.id = b.product_id
        WHERE i.token_hash = $1`,
      [tokenDigest(token)],
    );
    const row = found.rows[0];
    if (!row || row.used_at !== null || row.open !== true || row.reviewable !== true || row.reviewed === true) return null;
    if (!(await this.#eligibility({ providerId: String(row.provider_id), bookingId: String(row.booking_id), endUtc: isoValue(row, "end_at") }))) return null;
    return {
      experienceTitle: String(row.public_title),
      hostDisplayName: String(row.seller_display_name),
      sessionStartUtc: isoValue(row, "start_at"),
      expiresAtUtc: isoValue(row, "expires_at"),
    };
  }

  /**
   * The guest's review through a link, PENDING until NIHO checks it. The link takes one review: the same
   * clientRequestKey again answers `received`; anything else is StoreConflictError, as is a booking that
   * already has a review. Unknown, expired or no longer reviewable: StoreNotFoundError.
   */
  async submitReview(token: string, input: SubmitGuestReviewInput): Promise<{ status: "received" }> {
    if (typeof token !== "string" || !TOKEN.test(token)) throw new StoreNotFoundError("review link");
    const review = validReview(input);
    try {
      return await withTransaction(this.#pool, async (client) => {
        const found = await client.query<DbRow>(
          `SELECT provider_id, booking_id::text AS booking_id, used_at, used_client_request_key, expires_at > clock_timestamp() AS open
             FROM guest_review_invitations WHERE token_hash = $1 FOR UPDATE`,
          [tokenDigest(token)],
        );
        const link = found.rows[0];
        if (!link) throw new StoreNotFoundError("review link");
        if (link.used_at !== null) {
          if (link.used_client_request_key === review.clientRequestKey) return RECEIVED;
          throw new StoreConflictError("The review link was already used.");
        }
        if (link.open !== true) throw new StoreNotFoundError("review link");
        const providerId = String(link.provider_id);
        const bookingId = String(link.booking_id);
        const bookings = await client.query<DbRow>(
          `SELECT b.product_id, ${ENDED_AT} AS end_at, ${REVIEWABLE} AS reviewable, ${REVIEWED} AS reviewed
             FROM bookings b WHERE b.provider_id = $1 AND b.id = $2::bigint`,
          [providerId, bookingId],
        );
        const booking = bookings.rows[0];
        if (!booking || booking.reviewable !== true) throw new StoreNotFoundError("review link");
        if (booking.reviewed === true) throw new StoreConflictError("The booking already has a review.");
        if (!(await this.#eligibility({ providerId, bookingId, endUtc: isoValue(booking, "end_at") }))) throw new StoreNotFoundError("review link");
        const reviewId = randomUUID();
        await client.query(
          `INSERT INTO guest_reviews
             (id, provider_id, product_id, booking_id, rating, body, language, tags, display_name, origin_label, note_to_host, submitted_at)
           VALUES ($1::uuid, $2, $3, $4::bigint, $5, $6, $7, $8::text[], $9, $10, $11, clock_timestamp())`,
          [reviewId, providerId, booking.product_id, bookingId, review.rating, review.body, review.language, review.tags,
            review.displayName, review.originLabel, review.noteToHost],
        );
        // Dated by the review itself (a Date parameter would lose the microseconds).
        await client.query(
          `UPDATE guest_review_invitations i SET used_at = g.submitted_at, used_client_request_key = $3
             FROM guest_reviews g
            WHERE i.token_hash = $1 AND g.provider_id = i.provider_id AND g.id = $2::uuid`,
          [tokenDigest(token), reviewId, review.clientRequestKey],
        );
        return RECEIVED;
      });
    } catch (error) {
      // Another link of the same booking took its review first.
      if (isUniqueViolation(error)) throw new StoreConflictError("The booking already has a review.");
      throw error;
    }
  }

  /* ---------- the experience page (public) ---------- */

  /**
   * The published reviews of the one PUBLISHED experience with this slug, the latest first, and the summary of
   * all of them. Null when no experience, or more than one, has the slug.
   */
  async listPublishedReviews(productSlug: string, options: { limit?: number } = {}): Promise<PublicGuestReviews | null> {
    if (typeof productSlug !== "string" || productSlug.length < 1 || productSlug.length > 160) return null;
    const limit = boundedInteger(options.limit ?? GUEST_REVIEW_LIMITS.publicListMax, "limit", 1, GUEST_REVIEW_LIMITS.publicListMax);
    // A slug is unique per provider only: two published experiences with it answer neither.
    const products = await this.#pool.query<DbRow>(
      "SELECT provider_id, id, seller_display_name FROM experience_products WHERE slug = $1 AND status = 'PUBLISHED' ORDER BY provider_id, id LIMIT 2",
      [productSlug],
    );
    const product = products.rows.length === 1 ? products.rows[0]! : undefined;
    if (!product) return null;
    const scope = [product.provider_id, product.id];
    const totals = await this.#pool.query<DbRow>(
      `SELECT count(*)::int AS count, round(avg(rating), 1)::text AS average
         FROM guest_reviews WHERE provider_id = $1 AND product_id = $2 AND status = 'PUBLISHED'`,
      scope,
    );
    const tagCounts = await this.#pool.query<DbRow>(
      `SELECT tag, count(*)::int AS count
         FROM guest_reviews, unnest(tags) AS tag
        WHERE provider_id = $1 AND product_id = $2 AND status = 'PUBLISHED'
        GROUP BY tag`,
      scope,
    );
    const reviews = await this.#pool.query<DbRow>(
      `SELECT id, rating, body, tags, display_name, origin_label, published_at, reply_body
         FROM guest_reviews WHERE provider_id = $1 AND product_id = $2 AND status = 'PUBLISHED'
        ORDER BY published_at DESC, id DESC LIMIT $3`,
      [...scope, limit],
    );
    const count = Number(totals.rows[0]?.count ?? 0);
    // The reply's name fits REVIEW_LIMITS.displayNameMaxLength, or the client refuses the whole answer.
    const hostName = clip(String(product.seller_display_name), GUEST_REVIEW_LIMITS.displayNameMaxLength);
    return {
      summary: {
        count,
        average: count === 0 ? null : Number(totals.rows[0]!.average),
        tags: tagCounts.rows
          .filter((row) => TAG_LABELS.has(String(row.tag)))
          .map((row) => ({ label: TAG_LABELS.get(String(row.tag))!, count: Number(row.count) }))
          .sort((a, b) => b.count - a.count || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0)),
      },
      reviews: reviews.rows.map((row) => ({
        id: String(row.id),
        rating: Number(row.rating) as PublicGuestReview["rating"],
        body: String(row.body),
        tags: (Array.isArray(row.tags) ? row.tags : []).flatMap((tag) => {
          const label = TAG_LABELS.get(String(tag));
          return label === undefined ? [] : [label];
        }),
        displayName: String(row.display_name),
        originLabel: nullable(row.origin_label),
        publishedAt: isoValue(row, "published_at"),
        fromBooking: true,
        // The English only: the Japanese the host wrote stays in the host console.
        reply: row.reply_body === null || row.reply_body === undefined ? null : { hostName, body: String(row.reply_body) },
      })),
    };
  }

  /* ---------- the host console (OWNER) ---------- */

  /** The provider's reviews, waiting for NIHO or published, the latest first. `cursor` is the previous page's nextCursor. */
  async listReviews(actor: HostActor, options: { cursor?: string | null; limit?: number } = {}): Promise<HostGuestReviewPage> {
    const limit = boundedInteger(options.limit ?? GUEST_REVIEW_LIMITS.hostListMax, "limit", 1, GUEST_REVIEW_LIMITS.hostListMax);
    const after = decodeCursor(options.cursor);
    return withTransaction(this.#pool, async (client) => {
      await requireOwner(client, actor);
      const result = await client.query<DbRow>(
        `SELECT ${HOST_COLUMNS} FROM ${HOST_FROM}
          WHERE r.provider_id = $1 AND r.status IN ('PENDING', 'PUBLISHED')
            AND ($2::timestamptz IS NULL OR (r.submitted_at, r.id) < ($2::timestamptz, $3::uuid))
          ORDER BY r.submitted_at DESC, r.id DESC
          LIMIT $4`,
        [actor.providerId, after?.at ?? null, after?.id ?? null, limit + 1],
      );
      const rows = result.rows.slice(0, limit);
      return {
        reviews: rows.map(hostReviewFromRow),
        nextCursor: result.rows.length > limit ? encodeCursor(rows.at(-1)!) : null,
      };
    });
  }

  /** One review. Another provider's, or one NIHO hid, is not found. */
  async getReview(actor: HostActor, reviewId: string): Promise<HostGuestReview> {
    const id = uuid(reviewId, "reviewId");
    return withTransaction(this.#pool, async (client) => {
      await requireOwner(client, actor);
      return hostReview(client, actor.providerId, id);
    });
  }

  /**
   * 返信: writes the one reply of a published review, or corrects it (it is never removed), when the reply is
   * still at `expectedRevision` (0: none yet). The same commandId with the same reply answers the review as it
   * is; anything else that does not match is StoreConflictError, as is a review that is not published.
   */
  async saveReply(actor: HostActor, reviewId: string, input: { english: string; japanese: string | null; commandId: string; expectedRevision: number }): Promise<HostGuestReview> {
    const id = uuid(reviewId, "reviewId");
    const commandId = uuid(input?.commandId, "commandId");
    const english = text(input?.english, "english", 1, GUEST_REVIEW_LIMITS.replyMaxLength);
    const japanese = optionalText(input?.japanese, "japanese", GUEST_REVIEW_LIMITS.replyMaxLength);
    const expectedRevision = boundedInteger(input?.expectedRevision, "expectedRevision", 0, 2_147_483_646);
    return withTransaction(this.#pool, async (client) => {
      await requireOwner(client, actor);
      const locked = await client.query<DbRow>(
        `SELECT status, reply_revision, reply_command_id, reply_body, reply_body_ja
           FROM guest_reviews WHERE provider_id = $1 AND id = $2::uuid FOR NO KEY UPDATE`,
        [actor.providerId, id],
      );
      const row = locked.rows[0];
      if (!row) throw new StoreNotFoundError("guest review");
      if (row.status !== "PUBLISHED") throw new StoreConflictError("Only a published review takes a reply.");
      if (row.reply_command_id === commandId) {
        if (row.reply_body === english && (row.reply_body_ja ?? null) === japanese) return hostReview(client, actor.providerId, id);
        throw new StoreConflictError("The reply command ID was already used with a different reply.");
      }
      if (Number(row.reply_revision) !== expectedRevision) throw new StoreConflictError("The reply changed since it was read.");
      await client.query(
        `UPDATE guest_reviews
            SET reply_body = $3, reply_body_ja = $4, reply_command_id = $5::uuid, reply_revision = reply_revision + 1,
                reply_author_niho_user_id = COALESCE(reply_author_niho_user_id, $6),
                replied_at = COALESCE(replied_at, clock_timestamp()),
                reply_edited_at = CASE WHEN reply_revision >= 1 THEN clock_timestamp() ELSE reply_edited_at END
          WHERE provider_id = $1 AND id = $2::uuid`,
        [actor.providerId, id, english, japanese, commandId, actor.nihoUserId],
      );
      return hostReview(client, actor.providerId, id);
    });
  }

  /**
   * 報告: tells NIHO about a review, once. The review stays as it is. The same commandId with the same report
   * answers the review as it is; another report is StoreConflictError, as is a review NIHO hid.
   */
  async reportReview(actor: HostActor, reviewId: string, input: { reason: GuestReviewReportReason; note?: string | null; commandId: string }): Promise<HostGuestReview> {
    const id = uuid(reviewId, "reviewId");
    const commandId = uuid(input?.commandId, "commandId");
    const reason = input?.reason;
    if (typeof reason !== "string" || !REASONS.has(reason)) throw new StoreValidationError("reason is not a known reason.");
    const note = optionalText(input?.note, "note", GUEST_REVIEW_LIMITS.reportNoteMaxLength);
    return withTransaction(this.#pool, async (client) => {
      await requireOwner(client, actor);
      const locked = await client.query<DbRow>(
        `SELECT status, report_reason, report_note, report_command_id
           FROM guest_reviews WHERE provider_id = $1 AND id = $2::uuid FOR NO KEY UPDATE`,
        [actor.providerId, id],
      );
      const row = locked.rows[0];
      if (!row) throw new StoreNotFoundError("guest review");
      if (row.status === "HIDDEN") throw new StoreConflictError("The review is no longer shown.");
      if (row.report_reason !== null) {
        const same = row.report_command_id === commandId && row.report_reason === reason && (row.report_note ?? null) === note;
        if (!same) throw new StoreConflictError("The review was already reported.");
        return hostReview(client, actor.providerId, id);
      }
      await client.query(
        `UPDATE guest_reviews
            SET report_reason = $3, report_note = $4, report_command_id = $5::uuid, reported_by_niho_user_id = $6, reported_at = clock_timestamp()
          WHERE provider_id = $1 AND id = $2::uuid`,
        [actor.providerId, id, reason, note, commandId, actor.nihoUserId],
      );
      return hostReview(client, actor.providerId, id);
    });
  }
}
