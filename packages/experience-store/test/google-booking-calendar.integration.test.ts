import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import type { Pool } from "pg";
import { GoogleBookingCalendarEvents } from "../src/google-booking-calendar.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;

async function booking(pool: Pool, productId: string, startUtc: string, status: "CONFIRMED" | "HOLD" = "CONFIRMED", providerId = "provider-a"): Promise<{ id: string; publicId: string }> {
  const start = new Date(startUtc);
  const end = new Date(start.getTime() + 90 * 60_000);
  const occurrenceId = `rule-${productId}@${startUtc}`;
  await pool.query(
    `INSERT INTO schedule_occurrences
       (provider_id,occurrence_id,product_id,rule_id,source_local_date,local_date,local_start_time,time_zone,start_at,end_at,
        duration_minutes,capacity,booking_cutoff_minutes,busy_buffer_before_minutes,busy_buffer_after_minutes,status,rescheduled,schedule_rule_version)
     VALUES ($6,$1,$2,$3,$7::date,$7::date,'10:00','Asia/Tokyo',$4,$5,90,6,60,0,0,'OPEN',false,1)`,
    [occurrenceId, productId, `rule-${productId}`, start, end, providerId, startUtc.slice(0, 10)],
  );
  const publicId = randomUUID();
  const snapshot = { occurrenceId, startUtc: start.toISOString(), endUtc: end.toISOString(), timeZone: "Asia/Tokyo" };
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO bookings
       (public_booking_id,provider_id,product_id,occurrence_id,status,seats,idempotency_key,hold_expires_at,occurrence_snapshot,pricing_snapshot,seller_snapshot,confirmed_at)
     VALUES ($1::uuid,$7,$2,$3,$4,3,$5,clock_timestamp()+interval '15 minutes',$6::jsonb,'{}','{}',CASE WHEN $4='CONFIRMED' THEN clock_timestamp() END)
     RETURNING id::text AS id`,
    [publicId, productId, occurrenceId, status, `key-${publicId}`, JSON.stringify(snapshot), providerId],
  );
  return { id: inserted.rows[0]!.id, publicId };
}

describe("Google booking calendar events", { skip: databaseUrl === undefined }, () => {
  it("writes confirmed bookings once, rewrites moved ones, deletes cancelled ones and starts over on a reconnect", async () => {
    const { Pool } = await import("pg");
    const schema = `google_booking_events_${randomUUID().replaceAll("-", "")}`;
    const pool = new Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });
    try {
      await pool.query(`CREATE SCHEMA "${schema}"`);
      for (const name of (await readdir(new URL("../migrations/", import.meta.url))).filter((item) => /^\d{4}.*\.sql$/.test(item)).sort()) {
        await pool.query(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
      }
      await pool.query("INSERT INTO experience_providers (id) VALUES ('provider-a'),('provider-b')");
      await pool.query("INSERT INTO provider_memberships (provider_id,niho_user_id,role) VALUES ('provider-a','owner-a','OWNER'),('provider-b','owner-b','OWNER')");
      for (const [provider, id, title] of [["provider-a", "tea", "Tea   ceremony"], ["provider-b", "zen", "Zen"]] as const) {
        await pool.query(
          `INSERT INTO experience_products
             (provider_id,id,slug,status,public_title,content,currency,unit_amount,cancellation_terms_ref,seller_niho_account_ref,stripe_connect_account_ref,seller_display_name)
           VALUES ($1,$2,$2,'PUBLISHED',$3,'{}','JPY',1000,'terms','seller','acct_synthetic','Synthetic')`, [provider, id, title],
        );
        await pool.query(
          `INSERT INTO schedule_rules
             (provider_id,id,product_id,time_zone,starts_on,local_start_time,duration_minutes,capacity,booking_cutoff_minutes,busy_buffer_before_minutes,busy_buffer_after_minutes,recurrence)
           VALUES ($1,$2,$3,'Asia/Tokyo','2000-01-01','10:00',90,6,60,0,0,'{"kind":"DAILY"}')`, [provider, `rule-${id}`, id],
        );
      }
      await pool.query(
        `INSERT INTO provider_google_connections
          (provider_id,connected_by_niho_user_id,encrypted_refresh_token,granted_scopes,busy_calendar_id,booking_calendar_id)
         VALUES ('provider-a','owner-a',$1,ARRAY['scope'],'primary-a','booking-a')`, ["x".repeat(40)],
      );
      const generation = async () => Number((await pool.query("SELECT connection_generation FROM provider_google_connections WHERE provider_id='provider-a'")).rows[0].connection_generation);
      const firstGeneration = await generation();

      const confirmed = await booking(pool, "tea", "2099-01-01T01:00:00.000Z");
      await booking(pool, "tea", "2099-01-02T01:00:00.000Z", "HOLD");
      await booking(pool, "tea", "2000-01-01T01:00:00.000Z");
      // Provider B has no Google connection: its bookings are never claimed.
      await booking(pool, "zen", "2099-01-01T01:00:00.000Z", "CONFIRMED", "provider-b");
      const events = new GoogleBookingCalendarEvents(pool);

      const [work] = await events.claimDue(10, 60_000);
      assert.ok(work);
      assert.deepEqual(
        { action: work.action, publicBookingId: work.publicBookingId, calendarId: work.calendarId, generation: work.connectionGeneration, title: work.title, startUtc: work.startUtc, attempts: work.attempts },
        { action: "WRITE", publicBookingId: confirmed.publicId, calendarId: "booking-a", generation: firstGeneration, title: "Tea ceremony（3名）", startUtc: "2099-01-01T01:00:00.000Z", attempts: 1 },
      );
      assert.equal(Object.keys(work).some((key) => /guest|email|name|phone/i.test(key)), false);
      // A held, a past or another provider's booking is not work; the claimed one is not handed out twice.
      assert.deepEqual(await events.claimDue(10, 60_000), []);

      assert.equal(await events.finish(work, "FAILED"), true);
      assert.deepEqual(await events.claimDue(10, 60_000), [], "a failure waits for its backoff");
      await pool.query("UPDATE google_booking_calendar_events SET next_attempt_at=clock_timestamp()-interval '1 second'");
      const [retry] = await events.claimDue(10, 60_000);
      assert.equal(retry?.attempts, 2);
      assert.equal(await events.finish(work, "WRITTEN"), false, "an old claim changes nothing");
      assert.equal(await events.finish(retry!, "WRITTEN"), true);
      assert.deepEqual(await events.claimDue(10, 60_000), [], "written and unchanged");

      // What was written differs from the booking (an event written before a fix): it is written again.
      await pool.query("UPDATE google_booking_calendar_events SET written_start_at='2099-01-01T00:00:00Z'");
      const [rewrite] = await events.claimDue(10, 60_000);
      assert.deepEqual([rewrite?.action, rewrite?.startUtc, rewrite?.endUtc], ["WRITE", "2099-01-01T01:00:00.000Z", "2099-01-01T02:30:00.000Z"]);
      await events.finish(rewrite!, "WRITTEN");
      assert.deepEqual(await events.claimDue(10, 60_000), []);

      // Cancelled: the written event is deleted, then nothing is left to do.
      await pool.query("UPDATE bookings SET status='CANCELLED',confirmed_at=NULL,cancelled_at=clock_timestamp() WHERE id=$1::bigint", [confirmed.id]);
      const [removal] = await events.claimDue(10, 60_000);
      assert.equal(removal?.action, "REMOVE");
      await events.finish(removal!, "REMOVED");
      assert.deepEqual(await events.claimDue(10, 60_000), []);
      const row = (await pool.query("SELECT state,written_start_at,attempts,claim_id FROM google_booking_calendar_events")).rows[0];
      assert.deepEqual([row.state, row.written_start_at, row.attempts, row.claim_id], ["ABSENT", null, 0, null]);

      // A reconnect writes the confirmed bookings again to the new booking calendar.
      const second = await booking(pool, "tea", "2099-01-03T01:00:00.000Z");
      const [beforeReconnect] = await events.claimDue(10, 60_000);
      await events.finish(beforeReconnect!, "WRITTEN");
      await pool.query(
        `UPDATE provider_google_connections SET booking_calendar_id='booking-a2',connection_generation=nextval('provider_google_connection_generation_seq')
          WHERE provider_id='provider-a'`,
      );
      const [afterReconnect] = await events.claimDue(10, 60_000);
      assert.deepEqual([afterReconnect?.publicBookingId, afterReconnect?.calendarId, afterReconnect?.connectionGeneration], [second.publicId, "booking-a2", await generation()]);
      await events.finish(afterReconnect!, "WRITTEN");
      // A write whose answer was lost: the booking is cancelled before a retry succeeds, and the event is still deleted.
      const cancel = (id: string) => pool.query("UPDATE bookings SET status='CANCELLED',confirmed_at=NULL,cancelled_at=clock_timestamp() WHERE id=$1::bigint", [id]);
      const lost = await booking(pool, "tea", "2099-01-05T01:00:00.000Z");
      const [attempt] = await events.claimDue(10, 60_000);
      assert.equal(attempt?.publicBookingId, lost.publicId);
      await events.finish(attempt!, "FAILED");
      await cancel(lost.id);
      await pool.query("UPDATE google_booking_calendar_events SET next_attempt_at=clock_timestamp()-interval '1 second'");
      const [cleanup] = await events.claimDue(10, 60_000);
      assert.deepEqual([cleanup?.action, cleanup?.publicBookingId], ["REMOVE", lost.publicId]);
      await events.finish(cleanup!, "REMOVED");
      // A run cut off mid-write (its lease ran out with nothing recorded) is deleted the same way.
      const cut = await booking(pool, "tea", "2099-01-06T01:00:00.000Z");
      const [unfinished] = await events.claimDue(10, 60_000);
      assert.equal(unfinished?.publicBookingId, cut.publicId);
      await cancel(cut.id);
      await pool.query("UPDATE google_booking_calendar_events SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE claim_id IS NOT NULL");
      const [afterCut] = await events.claimDue(10, 60_000);
      assert.deepEqual([afterCut?.action, afterCut?.publicBookingId], ["REMOVE", cut.publicId]);
      await events.finish(afterCut!, "REMOVED");
      assert.deepEqual(await events.claimDue(10, 60_000), []);
      const states = await pool.query("SELECT DISTINCT state FROM google_booking_calendar_events e JOIN bookings b ON b.id=e.booking_id WHERE b.status='CANCELLED'");
      assert.deepEqual(states.rows.map((row) => row.state), ["ABSENT"]);

      // The OWNER who connected leaves: nothing is written for that connection.
      await booking(pool, "tea", "2099-01-04T01:00:00.000Z");
      await pool.query("UPDATE provider_memberships SET active=false WHERE provider_id='provider-a'");
      assert.deepEqual(await events.claimDue(10, 60_000), []);
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
      await pool.end();
    }
  });

  it("never hands one booking to two runs", async () => {
    const { Pool } = await import("pg");
    const schema = `google_booking_race_${randomUUID().replaceAll("-", "")}`;
    const pool = new Pool({ connectionString: databaseUrl, max: 6, options: `-c search_path=${schema}` });
    try {
      await pool.query(`CREATE SCHEMA "${schema}"`);
      for (const name of (await readdir(new URL("../migrations/", import.meta.url))).filter((item) => /^\d{4}.*\.sql$/.test(item)).sort()) {
        await pool.query(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
      }
      await pool.query("INSERT INTO experience_providers (id) VALUES ('provider-a')");
      await pool.query("INSERT INTO provider_memberships (provider_id,niho_user_id,role) VALUES ('provider-a','owner-a','OWNER')");
      await pool.query(
        `INSERT INTO experience_products
           (provider_id,id,slug,status,public_title,content,currency,unit_amount,cancellation_terms_ref,seller_niho_account_ref,stripe_connect_account_ref,seller_display_name)
         VALUES ('provider-a','tea','tea','PUBLISHED','Tea','{}','JPY',1000,'terms','seller','acct_synthetic','Synthetic')`,
      );
      await pool.query(
        `INSERT INTO schedule_rules
           (provider_id,id,product_id,time_zone,starts_on,local_start_time,duration_minutes,capacity,booking_cutoff_minutes,busy_buffer_before_minutes,busy_buffer_after_minutes,recurrence)
         VALUES ('provider-a','rule-tea','tea','Asia/Tokyo','2000-01-01','10:00',90,6,60,0,0,'{"kind":"DAILY"}')`,
      );
      await pool.query(
        `INSERT INTO provider_google_connections
          (provider_id,connected_by_niho_user_id,encrypted_refresh_token,granted_scopes,busy_calendar_id,booking_calendar_id)
         VALUES ('provider-a','owner-a',$1,ARRAY['scope'],'primary-a','booking-a')`, ["x".repeat(40)],
      );
      for (const day of ["01", "02", "03"]) await booking(pool, "tea", `2099-01-${day}T01:00:00.000Z`);
      const events = new GoogleBookingCalendarEvents(pool);
      const claims = (await Promise.all(Array.from({ length: 5 }, () => events.claimDue(3, 60_000)))).flat();
      assert.equal(new Set(claims.map((work) => work.bookingId)).size, claims.length);
      assert.ok(claims.length <= 3);
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
      await pool.end();
    }
  });
});
