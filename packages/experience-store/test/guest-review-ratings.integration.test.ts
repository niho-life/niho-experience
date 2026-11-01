import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import type { Pool } from "pg";
import { StoreAccessDeniedError } from "../src/errors.ts";
import { GuestReviewRatings } from "../src/guest-review-ratings.ts";
import { GuestReviewRepository } from "../src/guest-reviews.ts";

/** 体験の一覧's ★ (#108): every shown review counted and averaged by experience, against a real schema, synthetic data only. */
const databaseUrl = process.env.TEST_DATABASE_URL;
const ownerA = { providerId: "provider-a", nihoUserId: "owner-a" } as const;
const ownerB = { providerId: "provider-b", nihoUserId: "owner-b" } as const;

async function withSchema(run: (pool: Pool) => Promise<void>): Promise<void> {
  const { Pool } = await import("pg");
  const schema = `review_ratings_${randomUUID().replaceAll("-", "")}`;
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
    for (const [provider, id, status] of [["provider-a", "walk", "PUBLISHED"], ["provider-a", "tea", "PUBLISHED"], ["provider-a", "quiet", "PUBLISHED"], ["provider-a", "draft", "DRAFT"], ["provider-b", "river", "PUBLISHED"]]) {
      await pool.query(
        `INSERT INTO experience_products
           (provider_id,id,slug,status,public_title,content,currency,unit_amount,cancellation_terms_ref,seller_niho_account_ref,stripe_connect_account_ref,seller_display_name)
         VALUES ($1,$2,$3,$4,$5,'{}','JPY',1000,'terms','seller','acct_synthetic','Sample Seller')`,
        [provider, id, `sample-${id}`, status, `Synthetic ${id}`],
      );
      await pool.query(
        `INSERT INTO schedule_rules
           (provider_id,id,product_id,time_zone,starts_on,local_start_time,duration_minutes,capacity,booking_cutoff_minutes,busy_buffer_before_minutes,busy_buffer_after_minutes,recurrence)
         VALUES ($1,$2,$3,'Asia/Tokyo','2000-01-01','10:00',90,6,60,0,0,'{"kind":"DAILY"}')`,
        [provider, `rule-${id}`, id],
      );
    }
    await run(pool);
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  }
}

let sequence = 0;

/** A confirmed booking whose session ended, and its review written `daysAgo` days ago; the review's id. */
async function review(pool: Pool, providerId: string, productId: string, rating: number, daysAgo: number): Promise<string> {
  sequence += 1;
  const end = new Date(Date.now() - (daysAgo * 24 + 2) * 3_600_000);
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
  const snapshot = { occurrenceId, startUtc: start.toISOString(), endUtc: end.toISOString(), timeZone: "Asia/Tokyo" };
  const booking = await pool.query<{ id: string }>(
    `INSERT INTO bookings
       (public_booking_id,provider_id,product_id,occurrence_id,status,seats,idempotency_key,hold_expires_at,occurrence_snapshot,pricing_snapshot,seller_snapshot,confirmed_at)
     VALUES ($1::uuid,$2,$3,$4,'CONFIRMED',1,$5,clock_timestamp() + interval '15 minutes',$6::jsonb,'{}','{}',clock_timestamp())
     RETURNING id::text AS id`,
    [randomUUID(), providerId, productId, occurrenceId, `sample-${sequence}`, JSON.stringify(snapshot)],
  );
  const id = randomUUID();
  await pool.query(
    `INSERT INTO guest_reviews (id,provider_id,product_id,booking_id,rating,body,language,tags,display_name,submitted_at)
     VALUES ($1,$2,$3,$4::bigint,$5,'Synthetic body','EN','{}','Sample Guest',$6)`,
    [id, providerId, productId, booking.rows[0]!.id, rating, new Date(end.getTime() + 3_600_000)],
  );
  return id;
}

describe("PostgreSQL guest review ratings (#108)", { skip: databaseUrl === undefined }, () => {
  it("counts and averages every shown review by experience for the OWNER, past the first page of レビュー", async () => {
    await withSchema(async (pool) => {
      const ratings = new GuestReviewRatings(pool);
      assert.deepEqual(await ratings.byProduct(ownerA), []);

      // tea's reviews are older than the 120 of walk, so レビュー's first page (100) has none of them.
      for (const rating of [5, 4, 4]) await review(pool, "provider-a", "tea", rating, 30);
      const hidden = await review(pool, "provider-a", "tea", 1, 30);
      await pool.query("UPDATE guest_reviews SET hidden_at = clock_timestamp() WHERE id = $1", [hidden]);
      for (let index = 0; index < 120; index += 1) await review(pool, "provider-a", "walk", index % 4 === 0 ? 4 : 5, 10);
      await review(pool, "provider-b", "river", 2, 5);

      const page = await new GuestReviewRepository(pool).listReviews(ownerA, { limit: 100 });
      assert.equal(page.reviews.length, 100);
      assert.equal(page.reviews.some((entry) => entry.productId === "tea"), false);

      // walk: 90 × 5 and 30 × 4 is 4.75, rounded as the experience page does. tea: the hidden one counts nowhere.
      assert.deepEqual(await ratings.byProduct(ownerA), [
        { productId: "tea", slug: "sample-tea", count: 3, average: "4.3" },
        { productId: "walk", slug: "sample-walk", count: 120, average: "4.8" },
      ]);
      assert.deepEqual(await ratings.byProduct(ownerB), [{ productId: "river", slug: "sample-river", count: 1, average: "2.0" }]);
    });
  });

  it("is the OWNER's only", async () => {
    await withSchema(async (pool) => {
      const ratings = new GuestReviewRatings(pool);
      await review(pool, "provider-a", "walk", 5, 1);
      for (const actor of [
        { providerId: "provider-a", nihoUserId: "editor-a" },
        { providerId: "provider-a", nihoUserId: "former-a" },
        { providerId: "provider-a", nihoUserId: "owner-b" },
        { ...ownerA, calendarRoleCeiling: "EDITOR" as const },
        { ...ownerA, calendarScope: "OPERATOR" as const },
      ]) {
        await assert.rejects(() => ratings.byProduct(actor), StoreAccessDeniedError);
      }
      assert.deepEqual(await ratings.byProduct(ownerA), [{ productId: "walk", slug: "sample-walk", count: 1, average: "5.0" }]);
    });
  });
});
