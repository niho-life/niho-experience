import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import type { Pool } from "pg";
import { StoreAccessDeniedError, StoreConflictError, StoreNotFoundError, StoreValidationError } from "../src/errors.ts";
import { GuestReviewRepository, type HostGuestReview, type SubmitGuestReviewInput } from "../src/guest-reviews.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
const ownerA = { providerId: "provider-a", nihoUserId: "owner-a" } as const;
const ownerB = { providerId: "provider-b", nihoUserId: "owner-b" } as const;
const LONG_SELLER = `Sample Seller ${"x".repeat(60)}`;

interface Context {
  readonly pool: Pool;
  readonly reviews: GuestReviewRepository;
  /** What the eligibility hook answers, and what it was asked. */
  readonly eligibility: { allow: boolean; calls: { providerId: string; bookingId: string; endUtc: string }[] };
}

interface SampleBooking {
  readonly providerId: string;
  readonly id: string;
  readonly publicId: string;
  readonly startUtc: string;
  readonly endUtc: string;
}

/** A fresh schema with every migration and synthetic providers, members, experiences and schedule rules. */
async function withSchema(run: (context: Context) => Promise<void>): Promise<void> {
  const { Pool } = await import("pg");
  const schema = `guest_reviews_${randomUUID().replaceAll("-", "")}`;
  const pool = new Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });
  try {
    await pool.query(`CREATE SCHEMA "${schema}"`);
    const migrations = (await readdir(new URL("../migrations/", import.meta.url))).filter((name) => /^\d{4}.*\.sql$/.test(name)).sort();
    for (const name of migrations) await pool.query(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
    await pool.query("INSERT INTO experience_providers (id) VALUES ('provider-a'),('provider-b')");
    await pool.query(
      `INSERT INTO provider_memberships (provider_id,niho_user_id,role,active) VALUES
         ('provider-a','owner-a','OWNER',true),('provider-a','editor-a','EDITOR',true),
         ('provider-a','former-a','OWNER',false),('provider-b','owner-b','OWNER',true)`,
    );
    const products: [string, string, string, string, string, string][] = [
      ["provider-a", "tea", "sample-tea", "PUBLISHED", "Synthetic tea", "Sample Seller A"],
      ["provider-a", "walk", "sample-walk", "PUBLISHED", "Synthetic walk", "Sample Seller A"],
      ["provider-a", "quiet", "sample-quiet", "PUBLISHED", "Synthetic quiet", "Sample Seller A"],
      ["provider-a", "long", "sample-long", "PUBLISHED", "Synthetic long", LONG_SELLER],
      ["provider-a", "draft", "sample-draft", "DRAFT", "Synthetic draft", "Sample Seller A"],
      ["provider-a", "dup", "sample-dup", "PUBLISHED", "Synthetic dup A", "Sample Seller A"],
      ["provider-b", "river", "sample-river", "PUBLISHED", "Synthetic river", "Sample Seller B"],
      ["provider-b", "dup", "sample-dup", "PUBLISHED", "Synthetic dup B", "Sample Seller B"],
    ];
    for (const [provider, id, slug, status, title, seller] of products) {
      await pool.query(
        `INSERT INTO experience_products
           (provider_id,id,slug,status,public_title,content,currency,unit_amount,cancellation_terms_ref,seller_niho_account_ref,stripe_connect_account_ref,seller_display_name)
         VALUES ($1,$2,$3,$4,$5,'{}','JPY',1000,'terms','seller','acct_synthetic',$6)`,
        [provider, id, slug, status, title, seller],
      );
      await pool.query(
        `INSERT INTO schedule_rules
           (provider_id,id,product_id,time_zone,starts_on,local_start_time,duration_minutes,capacity,booking_cutoff_minutes,busy_buffer_before_minutes,busy_buffer_after_minutes,recurrence)
         VALUES ($1,$2,$3,'Asia/Tokyo','2000-01-01','10:00',90,6,60,0,0,'{"kind":"DAILY"}')`,
        [provider, `rule-${id}`, id],
      );
    }
    const eligibility: Context["eligibility"] = { allow: true, calls: [] };
    const reviews = new GuestReviewRepository(pool, {
      eligibility: async (booking) => {
        eligibility.calls.push(booking);
        return eligibility.allow;
      },
    });
    await run({ pool, reviews, eligibility });
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  }
}

let sequence = 0;

/** A synthetic booking whose session ended `endedHoursAgo` hours ago (negative: still to come). */
async function booking(pool: Pool, options: { providerId?: string; productId?: string; status?: string; endedHoursAgo?: number } = {}): Promise<SampleBooking> {
  const providerId = options.providerId ?? "provider-a";
  const productId = options.productId ?? "tea";
  const status = options.status ?? "CONFIRMED";
  sequence += 1;
  const end = new Date(Date.now() - (options.endedHoursAgo ?? 2) * 3_600_000);
  const start = new Date(end.getTime() - 90 * 60_000);
  const localDate = new Date(Date.UTC(2000, 0, 1 + sequence)).toISOString().slice(0, 10);
  const occurrenceId = `rule-${productId}@${localDate}`;
  await pool.query(
    `INSERT INTO schedule_occurrences
       (provider_id,occurrence_id,product_id,rule_id,source_local_date,local_date,local_start_time,time_zone,start_at,end_at,
        duration_minutes,capacity,booking_cutoff_minutes,busy_buffer_before_minutes,busy_buffer_after_minutes,status,rescheduled,schedule_rule_version)
     VALUES ($1,$2,$3,$4,$5::date,$5::date,'10:00','Asia/Tokyo',$6,$7,90,6,60,0,0,'OPEN',false,1)`,
    [providerId, occurrenceId, productId, `rule-${productId}`, localDate, start, end],
  );
  const publicId = randomUUID();
  const snapshot = { occurrenceId, startUtc: start.toISOString(), endUtc: end.toISOString(), timeZone: "Asia/Tokyo" };
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO bookings
       (public_booking_id,provider_id,product_id,occurrence_id,status,seats,idempotency_key,hold_expires_at,occurrence_snapshot,pricing_snapshot,seller_snapshot,confirmed_at)
     VALUES ($1::uuid,$2,$3,$4,$5,1,$6,clock_timestamp() + interval '15 minutes',$7::jsonb,'{}','{}',CASE WHEN $5 = 'CONFIRMED' THEN clock_timestamp() END)
     RETURNING id::text AS id`,
    [publicId, providerId, productId, occurrenceId, status, `sample-${sequence}`, JSON.stringify(snapshot)],
  );
  return { providerId, id: inserted.rows[0]!.id, publicId, startUtc: snapshot.startUtc, endUtc: snapshot.endUtc };
}

/** The booker's personal details, which a review never carries. */
async function bookerDetails(pool: Pool, value: SampleBooking): Promise<void> {
  await pool.query(
    `INSERT INTO booking_guests
       (provider_id,booking_id,guest_name,guest_email,guest_email_key,guest_phone,guest_language,answers,adult_count,child_count,
        terms_consent_version,client_request_key,request_fingerprint,utm)
     VALUES ($1,$2::bigint,'Sample Booker','booker@example.com','booker@example.com','+81 90 0000 0000','EN','[]',1,0,'sample-terms',$3,$4,'{}')`,
    [value.providerId, value.id, randomUUID(), "0".repeat(64)],
  );
}

function input(overrides: Partial<SubmitGuestReviewInput> = {}): SubmitGuestReviewInput {
  return { rating: 5, body: "A calm and lovely afternoon.", tags: ["GREAT_HOST"], displayName: "Sample Guest", clientRequestKey: randomUUID(), ...overrides };
}

/** A review written through its link; its id. */
async function reviewOf(context: Context, value: SampleBooking, overrides: Partial<SubmitGuestReviewInput> = {}): Promise<string> {
  const { token } = await context.reviews.issueInvitation({ providerId: value.providerId, bookingId: value.id, ttlDays: 14 });
  await context.reviews.submitReview(token, input(overrides));
  const result = await context.pool.query<{ id: string }>("SELECT id FROM guest_reviews WHERE provider_id = $1 AND booking_id = $2::bigint", [value.providerId, value.id]);
  return result.rows[0]!.id;
}

/** Operations hide a review in the database (the store has no way to). */
async function hide(pool: Pool, reviewId: string): Promise<void> {
  await pool.query("UPDATE guest_reviews SET hidden_at = clock_timestamp() WHERE id = $1", [reviewId]);
}

async function insertRaw(pool: Pool, bookingId: string, overrides: Record<string, unknown> = {}): Promise<void> {
  const row: Record<string, unknown> = {
    id: randomUUID(), provider_id: "provider-a", product_id: "tea", booking_id: bookingId, rating: 4, body: "Synthetic body", language: "EN", tags: [], display_name: "Sample Guest", ...overrides,
  };
  const columns = Object.keys(row);
  await pool.query(`INSERT INTO guest_reviews (${columns.join(", ")}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(", ")})`, Object.values(row));
}

/** A different snapshot end for a booking, past the snapshot trigger. */
async function moveEnd(pool: Pool, value: SampleBooking, endUtc: string): Promise<void> {
  await pool.query("ALTER TABLE bookings DISABLE TRIGGER bookings_protect_snapshots");
  await pool.query("UPDATE bookings SET occurrence_snapshot = jsonb_set(occurrence_snapshot, '{endUtc}', to_jsonb($2::text)) WHERE public_booking_id = $1", [value.publicId, endUtc]);
  await pool.query("ALTER TABLE bookings ENABLE TRIGGER bookings_protect_snapshots");
}

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

describe("PostgreSQL guest reviews (#104 #108)", { skip: databaseUrl === undefined }, () => {
  it("keeps one review per booking and what the guest wrote, the report and the first reply as the database requires", async () => {
    await withSchema(async (context) => {
      const { pool } = context;
      const first = await booking(pool);
      const reviewId = await reviewOf(context, first);
      // A second review for the booking.
      await assert.rejects(() => insertRaw(pool, first.id), { code: "23505" });

      const fresh = await booking(pool);
      for (const bad of [
        { rating: 0 }, { rating: 6 }, { tags: ["PRICE"] }, { tags: ["GREAT_HOST", "GREAT_HOST", "GOOD_VALUE", "EASY_TO_FIND", "CALM_ATMOSPHERE", "GOOD_FOR_BEGINNERS"] },
        { display_name: "sample@guest" }, { display_name: " Sample" }, { display_name: "Sample\u0007" }, { body: " " }, { language: "FR" },
        { report_reason: "OTHER" }, { report_note: "Synthetic" }, { reply_body: "Thanks" },
      ]) {
        await assert.rejects(() => insertRaw(pool, fresh.id, bad), { code: "23514" }, JSON.stringify(bad));
      }

      // What the guest wrote, and when, stays.
      await assert.rejects(() => pool.query("UPDATE guest_reviews SET body = 'Changed' WHERE id = $1", [reviewId]), { code: "23514", message: /immutable/ });
      await assert.rejects(() => pool.query("UPDATE guest_reviews SET tags = '{GOOD_VALUE}' WHERE id = $1", [reviewId]), { code: "23514", message: /immutable/ });
      await assert.rejects(() => pool.query("UPDATE guest_reviews SET rating = 1 WHERE id = $1", [reviewId]), { code: "23514", message: /immutable/ });
      await assert.rejects(() => pool.query("UPDATE guest_reviews SET submitted_at = clock_timestamp() WHERE id = $1", [reviewId]), { code: "23514", message: /immutable/ });
      // Operations hide a review, and show it again, in the database alone.
      await pool.query("UPDATE guest_reviews SET hidden_at = clock_timestamp() WHERE id = $1", [reviewId]);
      await pool.query("UPDATE guest_reviews SET hidden_at = NULL WHERE id = $1", [reviewId]);
      // A report is all or nothing, and then stays.
      await assert.rejects(() => pool.query("UPDATE guest_reviews SET report_reason = 'OTHER' WHERE id = $1", [reviewId]), { code: "23514" });
      await pool.query(
        "UPDATE guest_reviews SET report_reason = 'OTHER', report_command_id = $2, reported_by_niho_user_id = 'owner-a', reported_at = clock_timestamp() WHERE id = $1",
        [reviewId, randomUUID()],
      );
      await assert.rejects(() => pool.query("UPDATE guest_reviews SET report_reason = 'UNTRUE' WHERE id = $1", [reviewId]), { code: "23514", message: /reported once/ });
      await assert.rejects(() => pool.query("UPDATE guest_reviews SET reported_at = clock_timestamp() WHERE id = $1", [reviewId]), { code: "23514", message: /reported once/ });
      // The translation is set once.
      await pool.query("UPDATE guest_reviews SET body_ja = '穏やかで素敵な午後でした。' WHERE id = $1", [reviewId]);
      await assert.rejects(() => pool.query("UPDATE guest_reviews SET body_ja = '別の訳' WHERE id = $1", [reviewId]), { code: "23514", message: /translation/ });
      // The first reply keeps its author and date, its revision only grows, and a reply is never removed.
      await context.reviews.saveReply(ownerA, reviewId, { english: "Thank you.", japanese: null, commandId: randomUUID(), expectedRevision: 0 });
      await assert.rejects(() => pool.query("UPDATE guest_reviews SET reply_author_niho_user_id = 'editor-a' WHERE id = $1", [reviewId]), { code: "23514", message: /first reply/ });
      await assert.rejects(() => pool.query("UPDATE guest_reviews SET replied_at = clock_timestamp() WHERE id = $1", [reviewId]), { code: "23514", message: /first reply/ });
      await assert.rejects(() => pool.query("UPDATE guest_reviews SET reply_revision = 0 WHERE id = $1", [reviewId]), { code: "23514", message: /only grows/ });
      await assert.rejects(
        () => pool.query(
          `UPDATE guest_reviews SET reply_body = NULL, reply_body_ja = NULL, reply_revision = 0, replied_at = NULL, reply_author_niho_user_id = NULL,
                  reply_command_id = NULL WHERE id = $1`,
          [reviewId],
        ),
        { code: "23514" },
      );
      // Links keep only a 32-byte digest and expire within 60 days.
      await assert.rejects(
        () => pool.query("INSERT INTO guest_review_invitations (token_hash, provider_id, booking_id, expires_at) VALUES ($1, 'provider-a', $2::bigint, clock_timestamp() + interval '1 day')", [Buffer.alloc(16), fresh.id]),
        { code: "23514" },
      );
      await assert.rejects(
        () => pool.query("INSERT INTO guest_review_invitations (token_hash, provider_id, booking_id, expires_at) VALUES ($1, 'provider-a', $2::bigint, clock_timestamp() + interval '61 days')", [Buffer.alloc(32), fresh.id]),
        { code: "23514" },
      );
    });
  });

  it("takes one review per link for a confirmed booking that ended, with the link kept only as a hash", async () => {
    await withSchema(async (context) => {
      const { pool, reviews, eligibility } = context;
      const stay = await booking(pool);
      await bookerDetails(pool, stay);
      const issued = await reviews.issueInvitation({ providerId: "provider-a", bookingId: stay.id, ttlDays: 14 });
      assert.match(issued.token, /^[A-Za-z0-9_-]{43}$/);
      const days = (Date.parse(issued.expiresAtUtc) - Date.now()) / 86_400_000;
      assert.ok(days > 13.9 && days < 14.01);
      assert.deepEqual(eligibility.calls.at(-1), { providerId: "provider-a", bookingId: stay.id, endUtc: stay.endUtc });
      const links = await pool.query<{ token_hash: Buffer; row: string }>("SELECT token_hash, i::text AS row FROM guest_review_invitations i");
      assert.equal(links.rows.length, 1);
      assert.equal(links.rows[0]?.token_hash.length, 32);
      assert.deepEqual(links.rows[0]?.token_hash, createHash("sha256").update(issued.token, "utf8").digest());
      assert.ok(!links.rows[0]?.row.includes(issued.token));

      const opened = await reviews.openInvitation(issued.token);
      assert.deepEqual(opened, { experienceTitle: "Synthetic tea", hostDisplayName: "Sample Seller A", sessionStartUtc: stay.startUtc, expiresAtUtc: issued.expiresAtUtc });
      assert.doesNotMatch(JSON.stringify(opened), new RegExp(`example\\.com|Sample Booker|${stay.publicId}`));

      // Nothing out of bounds reaches the table, and a refused review leaves the link open.
      for (const bad of [
        { rating: 0 }, { rating: 6 }, { rating: 4.5 }, { body: " " }, { body: "x".repeat(2001) }, { tags: ["PRICE"] },
        { displayName: "guest@example.com" }, { displayName: " " }, { displayName: "x".repeat(61) }, { displayName: "Sample\u0007" },
        { originLabel: "x".repeat(61) }, { noteToHost: "x".repeat(501) }, { clientRequestKey: "short" }, { language: "FR" as never },
      ]) {
        await assert.rejects(() => reviews.submitReview(issued.token, input(bad)), StoreValidationError, JSON.stringify(bad));
      }
      assert.ok(await reviews.openInvitation(issued.token));

      const key = randomUUID();
      const review = input({
        rating: 4, body: "  A calm and lovely afternoon.\nThank you!  ", tags: ["GREAT_HOST", "CALM_ATMOSPHERE", "GREAT_HOST"],
        displayName: "  Sample \n Guest ", originLabel: " United Kingdom ", noteToHost: "Sample note for the host", clientRequestKey: key,
      });
      assert.deepEqual(await reviews.submitReview(issued.token, review), { status: "received" });
      // The same review again is the same one; anything else through the link is refused.
      assert.deepEqual(await reviews.submitReview(issued.token, { ...review, body: "A retry with other words" }), { status: "received" });
      await assert.rejects(() => reviews.submitReview(issued.token, input()), StoreConflictError);
      assert.equal(await reviews.openInvitation(issued.token), null);
      const stored = await pool.query(
        "SELECT rating, body, tags, display_name, origin_label, note_to_host, language, hidden_at, reply_revision, r::text AS row FROM guest_reviews r",
      );
      assert.equal(stored.rows.length, 1);
      const { row, ...columns } = stored.rows[0];
      assert.deepEqual(columns, {
        rating: 4, body: "A calm and lovely afternoon.\nThank you!", tags: ["CALM_ATMOSPHERE", "GREAT_HOST"], display_name: "Sample Guest",
        origin_label: "United Kingdom", note_to_host: "Sample note for the host", language: "EN", hidden_at: null, reply_revision: 0,
      });
      // Never the booker's name, email or phone.
      assert.doesNotMatch(row, /Sample Booker|booker@example\.com|\+81/);
      const used = await pool.query("SELECT used_client_request_key, used_at IS NOT NULL AS used FROM guest_review_invitations");
      assert.deepEqual(used.rows, [{ used_client_request_key: key, used: true }]);
      // A reviewed booking takes no other link, nor a review through one issued before.
      await assert.rejects(() => reviews.issueInvitation({ providerId: "provider-a", bookingId: stay.id, ttlDays: 14 }), StoreConflictError);

      const twice = await booking(pool);
      const one = await reviews.issueInvitation({ providerId: "provider-a", bookingId: twice.id, ttlDays: 14 });
      const other = await reviews.issueInvitation({ providerId: "provider-a", bookingId: twice.id, ttlDays: 14 });
      await reviews.submitReview(one.token, input());
      assert.equal(await reviews.openInvitation(other.token), null);
      await assert.rejects(() => reviews.submitReview(other.token, input()), StoreConflictError);
      // Two links of one booking at the same time: one review, the other refused.
      const raced = await booking(pool);
      const links2 = await Promise.all([1, 2].map(() => reviews.issueInvitation({ providerId: "provider-a", bookingId: raced.id, ttlDays: 14 })));
      const outcomes = await Promise.allSettled(links2.map((link) => reviews.submitReview(link.token, input())));
      assert.deepEqual(outcomes.map((outcome) => outcome.status).sort(), ["fulfilled", "rejected"]);
      assert.ok(outcomes.some((outcome) => outcome.status === "rejected" && outcome.reason instanceof StoreConflictError));

      // Only a confirmed booking whose session ended within the last 30 days.
      for (const value of [
        await booking(pool, { status: "HOLD" }),
        await booking(pool, { status: "CANCELLED" }),
        await booking(pool, { endedHoursAgo: -2 }),
        await booking(pool, { endedHoursAgo: 30 * 24 + 1 }),
      ]) {
        await assert.rejects(() => reviews.issueInvitation({ providerId: "provider-a", bookingId: value.id, ttlDays: 14 }), StoreNotFoundError);
      }
      await assert.rejects(() => reviews.issueInvitation({ providerId: "provider-b", bookingId: stay.id, ttlDays: 14 }), StoreNotFoundError);
      await assert.rejects(() => reviews.issueInvitation({ providerId: "provider-a", bookingId: "9000000000", ttlDays: 14 }), StoreNotFoundError);
      const late = await booking(pool, { endedHoursAgo: 29 * 24 });
      const lateLink = await reviews.issueInvitation({ providerId: "provider-a", bookingId: late.id, ttlDays: 14 });
      // The window closes with the link still unexpired: it neither opens nor takes a review.
      await moveEnd(pool, late, daysAgo(31));
      assert.equal(await reviews.openInvitation(lateLink.token), null);
      await assert.rejects(() => reviews.submitReview(lateLink.token, input()), StoreNotFoundError);
      for (const bad of [{ ttlDays: 0 }, { ttlDays: 31 }, { bookingId: "sample" }, { bookingId: "0" }, { bookingId: "99999999999999999999" }]) {
        await assert.rejects(() => reviews.issueInvitation({ providerId: "provider-a", bookingId: stay.id, ttlDays: 14, ...bad }), StoreValidationError);
      }

      // The eligibility hook (attendance, later) closes issuing, opening and writing alike.
      const absent = await booking(pool);
      const absentLink = await reviews.issueInvitation({ providerId: "provider-a", bookingId: absent.id, ttlDays: 14 });
      eligibility.allow = false;
      await assert.rejects(() => reviews.issueInvitation({ providerId: "provider-a", bookingId: absent.id, ttlDays: 14 }), StoreNotFoundError);
      assert.equal(await reviews.openInvitation(absentLink.token), null);
      await assert.rejects(() => reviews.submitReview(absentLink.token, input()), StoreNotFoundError);
      eligibility.allow = true;
      assert.ok(await reviews.openInvitation(absentLink.token));

      // An expired link neither opens nor takes a review; an unknown one is not found.
      const expiring = await booking(pool);
      const expired = await reviews.issueInvitation({ providerId: "provider-a", bookingId: expiring.id, ttlDays: 1 });
      await pool.query("UPDATE guest_review_invitations SET created_at = created_at - interval '2 days', expires_at = expires_at - interval '2 days' WHERE booking_id = $1::bigint", [expiring.id]);
      assert.equal(await reviews.openInvitation(expired.token), null);
      await assert.rejects(() => reviews.submitReview(expired.token, input()), StoreNotFoundError);
      assert.equal(await reviews.openInvitation("A".repeat(43)), null);
      assert.equal(await reviews.openInvitation("not-a-token"), null);
      await assert.rejects(() => reviews.submitReview("B".repeat(43), input()), StoreNotFoundError);
      await assert.rejects(() => reviews.submitReview("short", input()), StoreNotFoundError);

      assert.equal((await pool.query("SELECT count(*)::int AS n FROM guest_reviews")).rows[0].n, 3);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM outbox_messages")).rows[0].n, 0);
    });
  });

  it("shows a review as soon as it is written, on its own published experience only, with a summary of all shown", async () => {
    await withSchema(async (context) => {
      const { pool, reviews } = context;
      const oldest = await reviewOf(context, await booking(pool), { rating: 5, tags: ["GREAT_HOST", "CALM_ATMOSPHERE"], originLabel: "United Kingdom" });
      // Written, so shown: nobody publishes it.
      assert.deepEqual((await reviews.listPublishedReviews("sample-tea"))?.reviews.map((item) => item.id), [oldest]);
      const middle = await reviewOf(context, await booking(pool), { rating: 4, tags: ["GREAT_HOST"], noteToHost: "Sample private note" });
      const newest = await reviewOf(context, await booking(pool), { rating: 4, tags: ["GOOD_VALUE"] });
      // A hidden one counts nowhere: with its 1 star the average would be 3.5.
      const hidden = await reviewOf(context, await booking(pool), { rating: 1, tags: ["EASY_TO_FIND"] });
      await hide(pool, hidden);
      const walk = await reviewOf(context, await booking(pool, { productId: "walk" }), { rating: 2 });
      const river = await reviewOf(context, await booking(pool, { providerId: "provider-b", productId: "river" }), { rating: 3 });
      await reviewOf(context, await booking(pool, { productId: "dup" }));
      await reviewOf(context, await booking(pool, { productId: "draft" }));
      const reply = await reviews.saveReply(ownerA, middle, { english: "Thank you for coming.", japanese: "来てくださってありがとう。", commandId: randomUUID(), expectedRevision: 0 });
      assert.equal(reply.reply?.revision, 1);

      const page = await reviews.listPublishedReviews("sample-tea");
      assert.ok(page);
      assert.deepEqual(page.summary, {
        count: 3,
        average: 4.3,
        tags: [{ label: "Great host", count: 2 }, { label: "Calm atmosphere", count: 1 }, { label: "Good value", count: 1 }],
      });
      assert.deepEqual(page.reviews.map((item) => item.id), [newest, middle, oldest]);
      assert.ok(!page.reviews.some((item) => item.id === hidden));
      const [first, second, third] = page.reviews;
      assert.deepEqual(Object.keys(first!).sort(), ["body", "displayName", "fromBooking", "id", "originLabel", "publishedAt", "rating", "reply", "tags"]);
      assert.deepEqual(second?.reply, { hostName: "Sample Seller A", body: "Thank you for coming." });
      assert.equal(first?.reply, null);
      assert.deepEqual(third, {
        id: oldest, rating: 5, body: "A calm and lovely afternoon.", tags: ["Calm atmosphere", "Great host"], displayName: "Sample Guest",
        originLabel: "United Kingdom", publishedAt: third?.publishedAt, fromBooking: true, reply: null,
      });
      // Published when written.
      const written = await pool.query<{ submitted_at: Date }>("SELECT submitted_at FROM guest_reviews WHERE id = $1", [oldest]);
      assert.equal(third?.publishedAt, written.rows[0]?.submitted_at.toISOString());
      assert.match(third!.publishedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      assert.ok(Date.parse(second!.publishedAt) > Date.parse(third!.publishedAt));
      // Never the host's Japanese, the private note, the booking, the guest's details or the provider's ids.
      assert.doesNotMatch(JSON.stringify(page), /来て|Sample private note|example\.com|provider-|owner-|"tea"|note_to_host|bookingId|bodyJa/);

      // The limit cuts the list, never the summary.
      const one = await reviews.listPublishedReviews("sample-tea", { limit: 1 });
      assert.deepEqual(one?.reviews.map((item) => item.id), [newest]);
      assert.deepEqual(one?.summary, page.summary);
      await assert.rejects(() => reviews.listPublishedReviews("sample-tea", { limit: 0 }), StoreValidationError);
      await assert.rejects(() => reviews.listPublishedReviews("sample-tea", { limit: 51 }), StoreValidationError);

      // Each experience its own; one slug published by two providers, a draft or nothing answers null.
      assert.deepEqual((await reviews.listPublishedReviews("sample-walk"))?.reviews.map((item) => item.id), [walk]);
      assert.deepEqual((await reviews.listPublishedReviews("sample-river"))?.reviews.map((item) => item.id), [river]);
      for (const slug of ["sample-dup", "sample-draft", "sample-missing", "", "x".repeat(161)]) assert.equal(await reviews.listPublishedReviews(slug), null, slug);
      assert.deepEqual(await reviews.listPublishedReviews("sample-quiet"), { summary: { count: 0, average: null, tags: [] }, reviews: [] });

      // A seller name longer than a review's name limit is cut to fit it.
      const long = await reviewOf(context, await booking(pool, { productId: "long" }));
      await reviews.saveReply(ownerA, long, { english: "Thanks!", japanese: null, commandId: randomUUID(), expectedRevision: 0 });
      const longPage = await reviews.listPublishedReviews("sample-long");
      assert.equal(longPage?.reviews[0]?.reply?.hostName, LONG_SELLER.slice(0, 60));
      assert.deepEqual(longPage?.summary, { count: 1, average: 5, tags: [{ label: "Great host", count: 1 }] });
    });
  });

  it("lets only the OWNER read, answer and report the provider's reviews, never with the booker's details", async () => {
    await withSchema(async (context) => {
      const { pool, reviews } = context;
      const firstBooking = await booking(pool);
      await bookerDetails(pool, firstBooking);
      const first = await reviewOf(context, firstBooking, { noteToHost: "Sample private note", language: "JA", tags: ["GOOD_VALUE", "EASY_TO_FIND"] });
      const secondBooking = await booking(pool);
      await bookerDetails(pool, secondBooking);
      const second = await reviewOf(context, secondBooking);
      const hidden = await reviewOf(context, await booking(pool));
      await hide(pool, hidden);
      const river = await reviewOf(context, await booking(pool, { providerId: "provider-b", productId: "river" }));

      const reply = { english: "Thank you for coming.", japanese: "来てくださってありがとう。", commandId: randomUUID(), expectedRevision: 0 };
      const report = { reason: "PERSONAL" as const, note: "It names a person.", commandId: randomUUID() };
      // Not the OWNER, an inactive OWNER, another provider's OWNER, NIHO capping the role, a product operator.
      for (const actor of [
        { providerId: "provider-a", nihoUserId: "editor-a" },
        { providerId: "provider-a", nihoUserId: "former-a" },
        { providerId: "provider-a", nihoUserId: "owner-b" },
        { ...ownerA, calendarRoleCeiling: "EDITOR" as const },
        { ...ownerA, calendarScope: "OPERATOR" as const },
      ]) {
        await assert.rejects(() => reviews.listReviews(actor), StoreAccessDeniedError);
        await assert.rejects(() => reviews.getReview(actor, second), StoreAccessDeniedError);
        await assert.rejects(() => reviews.saveReply(actor, second, reply), StoreAccessDeniedError);
        await assert.rejects(() => reviews.reportReview(actor, second, report), StoreAccessDeniedError);
      }

      // Written, so listed: nothing stands between the guest and the host.
      const list = await reviews.listReviews(ownerA);
      assert.equal(list.nextCursor, null);
      assert.deepEqual(list.reviews.map((item) => item.id), [second, first]);
      const earliest = list.reviews[1]!;
      assert.deepEqual(earliest, {
        id: first, productId: "tea", productTitle: "Synthetic tea", bookingPublicId: firstBooking.publicId, sessionStartUtc: firstBooking.startUtc,
        reviewerName: "Sample Guest", reviewerOrigin: null, rating: 5, tags: ["EASY_TO_FIND", "GOOD_VALUE"], body: "A calm and lovely afternoon.", bodyJa: null,
        language: "JA", noteToHost: "Sample private note", submittedAtUtc: earliest.submittedAtUtc, reply: null, report: null,
      } satisfies HostGuestReview);
      assert.doesNotMatch(JSON.stringify(list), /Sample Booker|booker@example\.com|\+81|owner-a/);
      assert.deepEqual((await reviews.listReviews(ownerB)).reviews.map((item) => item.id), [river]);
      // Another provider's, a hidden one, or none at all is not found.
      for (const id of [river, hidden, randomUUID()]) {
        await assert.rejects(() => reviews.getReview(ownerA, id), StoreNotFoundError);
        await assert.rejects(() => reviews.saveReply(ownerA, id, reply), StoreNotFoundError);
        await assert.rejects(() => reviews.reportReview(ownerA, id, report), StoreNotFoundError);
      }
      await assert.rejects(() => reviews.getReview(ownerA, "not-a-uuid"), StoreValidationError);

      // 返信: on any shown review; the same command once; a stale revision is refused.
      const answered = await reviews.saveReply(ownerA, second, reply);
      assert.equal(answered.reply?.english, "Thank you for coming.");
      assert.equal(answered.reply?.japanese, "来てくださってありがとう。");
      assert.equal(answered.reply?.revision, 1);
      assert.equal(answered.reply?.editedAtUtc, null);
      assert.deepEqual(await reviews.saveReply(ownerA, second, reply), answered);
      await assert.rejects(() => reviews.saveReply(ownerA, second, { ...reply, english: "Other words." }), StoreConflictError);
      await assert.rejects(() => reviews.saveReply(ownerA, second, { ...reply, commandId: randomUUID() }), StoreConflictError);
      const correction = { english: "Thank you so much for coming.", japanese: null, commandId: randomUUID(), expectedRevision: 1 };
      const corrected = await reviews.saveReply(ownerA, second, correction);
      assert.equal(corrected.reply?.revision, 2);
      assert.equal(corrected.reply?.japanese, null);
      assert.equal(corrected.reply?.repliedAtUtc, answered.reply?.repliedAtUtc);
      assert.ok(corrected.reply?.editedAtUtc && Date.parse(corrected.reply.editedAtUtc) >= Date.parse(answered.reply!.repliedAtUtc));
      assert.deepEqual(await reviews.saveReply(ownerA, second, correction), corrected);
      await assert.rejects(() => reviews.saveReply(ownerA, second, { ...reply, commandId: randomUUID(), expectedRevision: 1 }), StoreConflictError);
      for (const bad of [{ english: " " }, { english: "x".repeat(2001) }, { japanese: "x".repeat(2001) }, { expectedRevision: -1 }, { commandId: "not-a-uuid" }]) {
        await assert.rejects(() => reviews.saveReply(ownerA, second, { ...reply, ...bad }), StoreValidationError);
      }
      const authors = await pool.query("SELECT reply_author_niho_user_id, reply_revision FROM guest_reviews WHERE id = $1", [second]);
      assert.deepEqual(authors.rows, [{ reply_author_niho_user_id: "owner-a", reply_revision: 2 }]);
      // English only from the start.
      const plain = await reviewOf(context, await booking(pool));
      assert.equal((await reviews.saveReply(ownerA, plain, { english: "See you again.", japanese: "", commandId: randomUUID(), expectedRevision: 0 })).reply?.japanese, null);

      // 報告: once per review, and the review stays shown.
      await assert.rejects(() => reviews.reportReview(ownerA, first, { ...report, reason: "SPAM" as never }), StoreValidationError);
      await assert.rejects(() => reviews.reportReview(ownerA, first, { ...report, note: "x".repeat(501) }), StoreValidationError);
      const reported = await reviews.reportReview(ownerA, first, report);
      assert.equal(reported.report?.reason, "PERSONAL");
      assert.equal(reported.report?.note, "It names a person.");
      assert.deepEqual(await reviews.reportReview(ownerA, first, report), reported);
      await assert.rejects(() => reviews.reportReview(ownerA, first, { ...report, note: "Other words." }), StoreConflictError);
      await assert.rejects(() => reviews.reportReview(ownerA, first, { ...report, commandId: randomUUID() }), StoreConflictError);
      const untrue = { reason: "UNTRUE" as const, commandId: randomUUID() };
      const flagged = await reviews.reportReview(ownerA, second, untrue);
      assert.equal(flagged.report?.note, null);
      assert.equal(flagged.reply?.revision, 2);
      assert.deepEqual((await reviews.listPublishedReviews("sample-tea"))?.reviews.map((item) => item.id), [plain, second, first]);
      assert.deepEqual((await reviews.listReviews(ownerA)).reviews.map((item) => item.id), [plain, second, first]);

      // Hidden in the database: gone from the page, the list, the reply and the report, retries included.
      await hide(pool, second);
      const page = await reviews.listPublishedReviews("sample-tea");
      assert.deepEqual(page?.reviews.map((item) => item.id), [plain, first]);
      assert.equal(page?.summary.count, 2);
      assert.deepEqual((await reviews.listReviews(ownerA)).reviews.map((item) => item.id), [plain, first]);
      await assert.rejects(() => reviews.getReview(ownerA, second), StoreNotFoundError);
      await assert.rejects(() => reviews.saveReply(ownerA, second, correction), StoreNotFoundError);
      await assert.rejects(() => reviews.saveReply(ownerA, second, { ...correction, commandId: randomUUID(), expectedRevision: 2 }), StoreNotFoundError);
      await assert.rejects(() => reviews.reportReview(ownerA, second, untrue), StoreNotFoundError);

      // Pages, the latest first, each review once.
      for (let index = 0; index < 3; index += 1) await reviewOf(context, await booking(pool));
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const next: Awaited<ReturnType<GuestReviewRepository["listReviews"]>> = await reviews.listReviews(ownerA, { limit: 2, cursor });
        assert.ok(next.reviews.length <= 2);
        seen.push(...next.reviews.map((item) => item.id));
        cursor = next.nextCursor;
      } while (cursor);
      assert.equal(seen.length, 5);
      assert.equal(new Set(seen).size, 5);
      assert.deepEqual(seen.slice(-2), [plain, first]);
      await assert.rejects(() => reviews.listReviews(ownerA, { cursor: "bm90LWEtY3Vyc29y" }), StoreValidationError);
      await assert.rejects(() => reviews.listReviews(ownerA, { limit: 101 }), StoreValidationError);
    });
  });
});
