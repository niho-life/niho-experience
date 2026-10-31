import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { Occurrence } from "@niho-experience/experience-domain";
import { evaluateStoredInventory, ExperienceStore, GoogleBookingCalendarEvents } from "@niho-experience/experience-store";
import { GOOGLE_SCOPES, removeBookingEvent, writeConfirmedBooking } from "@niho-experience/google-calendar";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: {} }));
vi.mock("@/lib/experience/store-server", () => ({ experiencePool: () => null }));
vi.mock("@/lib/host/server", () => ({ siteOrigin: () => "https://experience.example" }));
vi.mock("./google-token-crypto", () => ({
  googleTokenKey: () => Buffer.alloc(32),
  openGoogleRefreshToken: (_key: Buffer, _providerId: string, value: string) => value,
  sealGoogleRefreshToken: () => "z".repeat(40),
}));

import { runGoogleBookingEvents, runGoogleBusySync } from "./google-calendar-jobs";
import { googleAccessTokenForConnection, googleRuntimeConfig, syncOneDueProviderGoogle } from "./google-connection";
import { syncOneDueResourceGoogleAsScheduler } from "./resource-google";

const databaseUrl = process.env.TEST_DATABASE_URL;
const saved = { ...process.env };
const command = (suffix: number) => `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const actor = { providerId: "provider-a", nihoUserId: "owner-a", calendarRoleCeiling: "OWNER" as const };

/** A synthetic Google: the token endpoint, freeBusy and the booking calendar's events. Nothing leaves the process. */
function fakeGoogle() {
  const state = {
    revoked: false,
    broken: new Set<string>(),
    busy: {} as Record<string, { start: string; end: string }[]>,
    events: new Map<string, { status: string; body: Record<string, unknown> }>(),
    freeBusyCalls: 0,
  };
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    if (url === "https://oauth2.googleapis.com/token") {
      return state.revoked ? Response.json({ error: "invalid_grant" }, { status: 400 }) : Response.json({ access_token: "synthetic-access", expires_in: 3600 });
    }
    if (url.endsWith("/freeBusy")) {
      state.freeBusyCalls += 1;
      const calendars: Record<string, unknown> = {};
      for (const { id } of body!.items as { id: string }[]) {
        // Google's own fields beyond the times (a title here) must not be kept.
        calendars[id] = state.broken.has(id) ? { errors: [{ domain: "global", reason: "notFound" }], busy: [] }
          : { busy: (state.busy[id] ?? []).map((slot) => ({ ...slot, summary: "Private dentist" })) };
      }
      return Response.json({ kind: "calendar#freeBusy", calendars });
    }
    const match = /\/calendars\/([^/]+)\/events(?:\/([a-v0-9]+))?$/.exec(url);
    if (match) {
      const key = `${decodeURIComponent(match[1]!)}/${match[2] ?? body?.id}`;
      if (method === "PUT") {
        if (!state.events.has(key)) return new Response(null, { status: 404 });
        state.events.set(key, { status: String(body!.status), body: body! });
        return Response.json({ id: match[2] });
      }
      if (method === "POST") {
        if (state.events.has(key)) return new Response(null, { status: 409 });
        state.events.set(key, { status: "confirmed", body: body! });
        return Response.json({ id: body!.id });
      }
      if (method === "DELETE") {
        if (!state.events.has(key) || state.events.get(key)!.status === "cancelled") return new Response(null, { status: 410 });
        state.events.get(key)!.status = "cancelled";
        return new Response(null, { status: 204 });
      }
    }
    return new Response(null, { status: 500 });
  });
  return { state, fetch };
}

async function migrate(pool: Pool, schema: string) {
  await pool.query(`CREATE SCHEMA "${schema}"`);
  const migrationUrl = new URL("../../../../../packages/experience-store/migrations/", import.meta.url);
  for (const name of (await readdir(migrationUrl)).filter((item) => /^\d{4}.*\.sql$/.test(item)).sort()) {
    await pool.query(await readFile(new URL(name, migrationUrl), "utf8"));
  }
}

/** Day `days` from today at `hhmm` Japan time, 60 minutes, as an occurrence of `productId`'s rule. */
function occurrence(productId: string, days: number, hhmm: string): Occurrence {
  const [hh, mm] = hhmm.split(":").map(Number) as [number, number];
  const today = new Date();
  const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + days, hh - 9, mm));
  const startUtc = start.toISOString();
  const endUtc = new Date(start.getTime() + 60 * 60_000).toISOString();
  const localDate = new Date(start.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
  return {
    id: `rule-${productId}@${startUtc}`, ruleId: `rule-${productId}`, sourceLocalDate: localDate, localDate, localStartTime: hhmm,
    timeZone: "Asia/Tokyo", startUtc, endUtc, durationMinutes: 60, capacity: 8, bookingCutoffMinutes: 0,
    busyBufferBeforeMinutes: 0, busyBufferAfterMinutes: 0, status: "OPEN", rescheduled: false,
  };
}

/** Japan-time wall clock as UTC ("+09:00" in, "Z" out), the way Google answers for an all-day or late event. */
const jst = (days: number, hhmm: string) => {
  const today = new Date();
  const [hh, mm] = hhmm.split(":").map(Number) as [number, number];
  const date = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + days));
  return `${date.toISOString().slice(0, 10)}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00+09:00`;
};

describe.skipIf(!databaseUrl)("Google calendar jobs against a synthetic Google and PostgreSQL", () => {
  let pool: Pool;
  let schema: string;
  const google = fakeGoogle();

  beforeAll(async () => {
    process.env.EXPERIENCE_RESOURCE_GOOGLE_ENABLED = "true";
    process.env.EXPERIENCE_GOOGLE_CLIENT_ID = "synthetic-client";
    process.env.EXPERIENCE_GOOGLE_CLIENT_SECRET = "synthetic-secret";
    delete process.env.EXPERIENCE_RESOURCE_GOOGLE_WATCH_ENABLED;
    vi.stubGlobal("fetch", google.fetch);
    const { Pool } = await import("pg");
    schema = `google_jobs_${randomUUID().replaceAll("-", "")}`;
    pool = new Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });
    await migrate(pool, schema);
    await pool.query("INSERT INTO experience_providers (id) VALUES ('provider-a')");
    await pool.query("INSERT INTO provider_memberships (provider_id,niho_user_id,role) VALUES ('provider-a','owner-a','OWNER')");
    const store = new ExperienceStore(pool);
    let sequence = 1;
    for (const [id, kind] of [["instructor-a", "INSTRUCTOR"], ["instructor-b", "INSTRUCTOR"], ["venue-1", "VENUE"]] as const) {
      await store.saveInventoryResource(actor, { id, kind, displayName: id, active: true }, null, command(sequence++));
    }
    // Two tea ceremonies share the venue with different instructors; the walk needs instructor B only.
    for (const [id, resources] of [["tea-a", ["instructor-a", "venue-1"]], ["tea-b", ["instructor-b", "venue-1"]], ["walk-b", ["instructor-b"]]] as const) {
      await store.createProduct(actor, {
        id, slug: id, status: "PUBLISHED", publicTitle: id, content: {}, currency: "JPY", unitAmount: 1000,
        cancellationTermsRef: "terms", sellerNihoAccountRef: "seller", stripeConnectAccountRef: "acct_synthetic", sellerDisplayName: "Synthetic",
      });
      await store.saveProductInventorySetting(actor, id, {
        bookingMode: "SEAT", resources: resources.map((resourceId) => ({ resourceId, prepareMinutes: 0, cleanupMinutes: 0 })),
      }, null, command(sequence++));
      await pool.query(
        `INSERT INTO schedule_rules
           (provider_id,id,product_id,time_zone,starts_on,local_start_time,duration_minutes,capacity,booking_cutoff_minutes,busy_buffer_before_minutes,busy_buffer_after_minutes,recurrence)
         VALUES ('provider-a',$1,$2,'Asia/Tokyo','2000-01-01','10:00',60,8,0,0,0,'{"kind":"DAILY"}')`, [`rule-${id}`, id],
      );
    }
    await pool.query(
      `INSERT INTO provider_google_connections
        (provider_id,connected_by_niho_user_id,encrypted_refresh_token,granted_scopes,busy_calendar_id,booking_calendar_id)
       VALUES ('provider-a','owner-a',$1,$2,'primary-a','booking-a')`, ["r".repeat(40), [...GOOGLE_SCOPES]],
    );
    await pool.query("INSERT INTO provider_google_calendars (provider_id,opaque_calendar_id,blocking_enabled,sync_status) VALUES ('provider-a','primary-a',true,'STALE')");
    for (const [resource, calendar] of [["instructor-a", "cal-instructor-a"], ["instructor-b", "cal-instructor-b"], ["venue-1", "cal-venue-1"]]) {
      await pool.query(
        `INSERT INTO resource_google_calendars (provider_id,resource_id,opaque_calendar_id,enabled,connection_generation)
         SELECT 'provider-a',$1,$2,true,connection_generation FROM provider_google_connections WHERE provider_id='provider-a'`, [resource, calendar],
      );
    }
  });

  afterEach(() => { google.fetch.mockClear(); });

  afterAll(async () => {
    vi.unstubAllGlobals();
    for (const name of ["EXPERIENCE_RESOURCE_GOOGLE_ENABLED", "EXPERIENCE_GOOGLE_CLIENT_ID", "EXPERIENCE_GOOGLE_CLIENT_SECRET", "EXPERIENCE_RESOURCE_GOOGLE_WATCH_ENABLED"]) {
      if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name];
    }
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
      await pool.end();
    }
  });

  const run = () => runGoogleBusySync({
    syncProvider: () => syncOneDueProviderGoogle(pool, new ExperienceStore(pool)),
    syncResource: () => syncOneDueResourceGoogleAsScheduler(pool),
    now: Date.now,
  });
  const due = async () => {
    await pool.query("UPDATE provider_google_calendars SET next_sync_due_at=clock_timestamp()-interval '1 second'");
    await pool.query("UPDATE resource_google_calendars SET next_sync_due_at=clock_timestamp()-interval '1 second'");
  };
  const reason = async (productId: string, item: Occurrence) =>
    (await evaluateStoredInventory(pool, "provider-a", productId, { ...item, id: `rule-${productId}@${item.startUtc}`, ruleId: `rule-${productId}` }, new Date().toISOString(), 1)).availability.reason;
  const notices = async () => (await pool.query<{ payload: { input: string; reason: string } }>(
    "SELECT payload FROM outbox_messages WHERE topic='host.notify.google_calendar_attention' ORDER BY id",
  )).rows.map((row) => `${row.payload.input}:${row.payload.reason}`);

  it("keeps instructors apart, shares the venue, reads all-day and overnight events in Japan time, and reopens a deleted busy time", async () => {
    expect(googleRuntimeConfig()).not.toBeNull();
    const first = occurrence("tea-a", 10, "11:00");
    const second = occurrence("tea-a", 11, "11:00");
    google.state.busy = {
      "cal-instructor-a": [{ start: first.startUtc, end: first.endUtc }],
      "cal-venue-1": [{ start: second.startUtc, end: second.endUtc }],
      // All day on day 12 in Japan, and 23:00-02:00 Japan time from day 13 into day 14.
      "cal-instructor-b": [{ start: jst(12, "00:00"), end: jst(13, "00:00") }, { start: jst(13, "23:00"), end: jst(14, "02:00") }],
    };
    // Nothing read yet: new bookings wait.
    expect(await reason("walk-b", first)).toBe("RESOURCE_GOOGLE_UNAVAILABLE");

    // No OTA worker or account: the scheduler reads the provider-wide input and the three resources.
    expect(await run()).toEqual({ providerReads: 1, providerFailed: 0, resourceReads: 3, resourceFailed: 0 });
    expect((await run()).resourceReads).toBe(0);
    const receipts = await pool.query("SELECT DISTINCT claimant,worker_id FROM resource_google_sync_receipts");
    expect(receipts.rows).toEqual([{ claimant: "SCHEDULER", worker_id: null }]);
    const fresh = await pool.query("SELECT fresh_until-clock_timestamp() > interval '24 minutes' AS long FROM provider_google_calendars");
    expect(fresh.rows[0].long).toBe(true);
    // Only the times are kept, never the event's title.
    const stored = await pool.query("SELECT to_jsonb(b) AS row FROM resource_google_busy_intervals b");
    expect(JSON.stringify(stored.rows)).not.toContain("dentist");

    // Instructor A's event closes A's tea ceremony only; B's tea ceremony and walk stay open.
    expect(await reason("tea-a", first)).toBe("RESOURCE_GOOGLE_BUSY");
    expect(await reason("tea-b", first)).toBe("AVAILABLE");
    expect(await reason("walk-b", first)).toBe("AVAILABLE");
    // The venue's event closes both tea ceremonies, not the walk.
    expect(await reason("tea-a", second)).toBe("RESOURCE_GOOGLE_BUSY");
    expect(await reason("tea-b", second)).toBe("RESOURCE_GOOGLE_BUSY");
    expect(await reason("walk-b", second)).toBe("AVAILABLE");
    // All day in Japan: 00:30 and 23:30 that day are busy, 00:30 the next day is not (it ended at 15:00 UTC).
    expect(await reason("walk-b", occurrence("walk-b", 12, "00:30"))).toBe("RESOURCE_GOOGLE_BUSY");
    expect(await reason("walk-b", occurrence("walk-b", 12, "22:30"))).toBe("RESOURCE_GOOGLE_BUSY");
    expect(await reason("walk-b", occurrence("walk-b", 13, "09:00"))).toBe("AVAILABLE");
    // Across midnight: 00:30 on day 14 is inside 23:00-02:00, 03:00 is not; 22:00 the night before ends before it.
    expect(await reason("walk-b", occurrence("walk-b", 14, "00:30"))).toBe("RESOURCE_GOOGLE_BUSY");
    expect(await reason("walk-b", occurrence("walk-b", 14, "03:00"))).toBe("AVAILABLE");
    expect(await reason("walk-b", occurrence("walk-b", 13, "22:00"))).toBe("AVAILABLE");

    // A booking already taken for A's tea ceremony on the first day.
    const booked = await confirmedBooking(pool, "tea-a", first, 3);
    // The host deletes A's event: the next read reopens the slot, and the booking still holds its seats.
    google.state.busy["cal-instructor-a"] = [];
    await due();
    await run();
    const evaluated = await evaluateStoredInventory(pool, "provider-a", "tea-a", first, new Date().toISOString(), 1);
    expect(evaluated.availability.reason).toBe("AVAILABLE");
    expect(evaluated.availability.remainingCapacity).toBe(5);
    expect((await pool.query("SELECT status FROM bookings WHERE id=$1::bigint", [booked])).rows[0].status).toBe("CONFIRMED");
    expect(await notices()).toEqual([]);
  });

  it("closes new bookings while Google refuses the connection, keeps bookings, tells the OWNER once and reopens only after a read", async () => {
    const first = occurrence("tea-a", 10, "11:00");
    google.state.revoked = true;
    await due();
    expect(await run()).toEqual({ providerReads: 1, providerFailed: 1, resourceReads: 3, resourceFailed: 3 });
    expect(await reason("tea-a", first)).toBe("RESOURCE_GOOGLE_UNAVAILABLE");
    expect(await reason("walk-b", first)).toBe("RESOURCE_GOOGLE_UNAVAILABLE");
    expect((await pool.query("SELECT count(*)::int AS n FROM bookings WHERE status='CONFIRMED'")).rows[0].n).toBe(1);
    // One notice for the refused connection, not one per input.
    expect(await notices()).toEqual(["PROVIDER:REVOKED"]);
    // A refused connection is tried again in 30 minutes, not every run.
    expect(await run()).toEqual({ providerReads: 0, providerFailed: 0, resourceReads: 0, resourceFailed: 0 });
    const retry = await pool.query("SELECT bool_and(next_sync_due_at>clock_timestamp()+interval '25 minutes') AS later FROM resource_google_calendars");
    expect(retry.rows[0].later).toBe(true);

    // Google takes the token again (the client was fixed, or the OWNER reconnected the same generation): reopened.
    google.state.revoked = false;
    await due();
    await run();
    expect(await reason("walk-b", first)).toBe("AVAILABLE");
    const cleared = await pool.query("SELECT count(*)::int AS n FROM resource_google_calendars WHERE failing_since IS NOT NULL OR sync_status<>'FRESH'");
    expect(cleared.rows[0].n).toBe(0);
    expect(await notices()).toEqual(["PROVIDER:REVOKED"]);
  });

  it("tells the OWNER about a calendar that cannot be read only after 15 minutes, once, and closes only what needs it", async () => {
    const first = occurrence("tea-a", 10, "11:00");
    await pool.query("DELETE FROM outbox_messages WHERE topic='host.notify.google_calendar_attention'");
    google.state.broken.add("cal-venue-1");
    await due();
    expect(await run()).toMatchObject({ resourceReads: 3, resourceFailed: 1 });
    expect(await reason("tea-a", first)).toBe("RESOURCE_GOOGLE_UNAVAILABLE");
    expect(await reason("tea-b", first)).toBe("RESOURCE_GOOGLE_UNAVAILABLE");
    expect(await reason("walk-b", first)).toBe("AVAILABLE");
    expect(await notices()).toEqual([]);
    await pool.query("UPDATE resource_google_calendars SET failing_since=failing_since-interval '16 minutes' WHERE resource_id='venue-1'");
    await due();
    await run();
    await due();
    await run();
    expect(await notices()).toEqual(["RESOURCE:UNAVAILABLE"]);
    google.state.broken.clear();
    await due();
    await run();
    expect(await reason("tea-a", first)).toBe("AVAILABLE");
  });

  it("writes confirmed bookings to the booking calendar with the title, time and party only, and deletes cancelled ones", async () => {
    const google2 = googleRuntimeConfig()!.google;
    const jobs = () => runGoogleBookingEvents({
      events: new GoogleBookingCalendarEvents(pool),
      accessToken: (providerId, generation) => googleAccessTokenForConnection(pool, providerId, generation),
      write: async (token, work) => { await writeConfirmedBooking(google2, token, work.calendarId, { id: work.publicBookingId, title: work.title, startUtc: work.startUtc, endUtc: work.endUtc }); },
      remove: (token, work) => removeBookingEvent(google2, token, work.calendarId, work.publicBookingId),
      now: Date.now,
    });
    expect(await jobs()).toEqual({ claimed: 1, written: 1, removed: 0, failed: 0 });
    expect(await jobs()).toEqual({ claimed: 0, written: 0, removed: 0, failed: 0 });
    const [key, event] = [...google.state.events.entries()][0]!;
    expect(key.startsWith("booking-a/")).toBe(true);
    expect(Object.keys(event!.body).sort()).toEqual(["end", "id", "start", "status", "summary", "transparency", "visibility"]);
    expect(event!.body.summary).toBe("tea-a（3名）");

    google.state.revoked = true;
    await pool.query("UPDATE bookings SET status='CANCELLED',confirmed_at=NULL,cancelled_at=clock_timestamp()");
    expect(await jobs()).toEqual({ claimed: 1, written: 0, removed: 0, failed: 1 });
    google.state.revoked = false;
    await pool.query("UPDATE google_booking_calendar_events SET next_attempt_at=clock_timestamp()-interval '1 second'");
    expect(await jobs()).toEqual({ claimed: 1, written: 0, removed: 1, failed: 0 });
    expect(google.state.events.get(key)!.status).toBe("cancelled");
  });
});

async function confirmedBooking(pool: Pool, productId: string, item: Occurrence, seats: number): Promise<string> {
  await pool.query(
    `INSERT INTO schedule_occurrences
       (provider_id,occurrence_id,product_id,rule_id,source_local_date,local_date,local_start_time,time_zone,start_at,end_at,
        duration_minutes,capacity,booking_cutoff_minutes,busy_buffer_before_minutes,busy_buffer_after_minutes,status,rescheduled,schedule_rule_version)
     VALUES ('provider-a',$1,$2,$3,$4::date,$4::date,$5,'Asia/Tokyo',$6,$7,60,8,0,0,0,'OPEN',false,1)`,
    [item.id, productId, item.ruleId, item.localDate, item.localStartTime, item.startUtc, item.endUtc],
  );
  const snapshot = { occurrenceId: item.id, startUtc: item.startUtc, endUtc: item.endUtc, timeZone: "Asia/Tokyo" };
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO bookings
       (public_booking_id,provider_id,product_id,occurrence_id,status,seats,idempotency_key,hold_expires_at,occurrence_snapshot,pricing_snapshot,seller_snapshot,confirmed_at)
     VALUES ($1::uuid,'provider-a',$2,$3,'CONFIRMED',$4,$5,clock_timestamp()+interval '15 minutes',$6::jsonb,'{}','{}',clock_timestamp())
     RETURNING id::text AS id`,
    [randomUUID(), productId, item.id, seats, `key-${randomUUID()}`, JSON.stringify(snapshot)],
  );
  return inserted.rows[0]!.id;
}
