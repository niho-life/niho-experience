import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAirbnbOutputCalendar, GOOGLE_SCOPES, GoogleCalendarError, googleAuthorizationUrl, queryGoogleBusy, queryGoogleBusyByCalendar, refreshGoogleToken, removeBookingEvent, watchGoogleCalendar, writeConfirmedBooking, type GoogleConfig } from "../src/index.ts";

const base = { clientId: "synthetic-client", clientSecret: "synthetic-secret", redirectUri: "https://experience.example.test/host/calendar/google/callback" };

function config(respond: (url: string, init: RequestInit) => Response | Promise<Response>): GoogleConfig {
  return { ...base, fetch: async (input, init) => respond(String(input), init ?? {}) };
}

describe("Google Calendar boundary", () => {
  it("requests narrow scopes with offline access and PKCE", () => {
    const url = new URL(googleAuthorizationUrl(base, "state-1", "challenge-1"));
    assert.equal(url.searchParams.get("access_type"), "offline");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.deepEqual(url.searchParams.get("scope")?.split(" "), [...GOOGLE_SCOPES]);
  });

  it("accepts a refresh response without a repeated scope when the stored grant was checked", async () => {
    const response = () => Response.json({ access_token: "synthetic-access", expires_in: 3600 });
    const result = await refreshGoogleToken(config(response), "synthetic-refresh", GOOGLE_SCOPES);
    assert.deepEqual(result.scopes, [...GOOGLE_SCOPES]);
    assert.equal(result.accessToken, "synthetic-access");
  });

  it("returns busy intervals only and rejects a per-calendar error", async () => {
    const grant = config(() => Response.json({ calendars: { private: { busy: [{ start: "2026-11-01T00:00:00Z", end: "2026-11-01T01:00:00Z", summary: "secret" }] } } }));
    assert.deepEqual(await queryGoogleBusy(grant, "token", ["private"], "2026-11-01T00:00:00Z", "2026-11-02T00:00:00Z"), [
      { startUtc: "2026-11-01T00:00:00.000Z", endUtc: "2026-11-01T01:00:00.000Z" },
    ]);
    const error = config(() => Response.json({ calendars: { private: { errors: [{ reason: "notFound" }], busy: [] } } }));
    await assert.rejects(() => queryGoogleBusy(error, "token", ["private"], "2026-11-01T00:00:00Z", "2026-11-02T00:00:00Z"), GoogleCalendarError);
  });

  it("keeps calendar keys, bounds responses, and refuses redirects", async () => {
    const keyed = config((_url, init) => {
      assert.equal(init.redirect, "manual");
      return Response.json({ calendars: { room: { busy: [] }, teacher: { busy: [{ start: "2026-11-01T01:00:00Z", end: "2026-11-01T02:00:00Z", attendees: ["secret"] }] } } });
    });
    assert.deepEqual(await queryGoogleBusyByCalendar(keyed, "token", ["room", "teacher"], "2026-11-01T00:00:00Z", "2026-11-02T00:00:00Z"), [
      { id: "room", busyIntervals: [] },
      { id: "teacher", busyIntervals: [{ startUtc: "2026-11-01T01:00:00.000Z", endUtc: "2026-11-01T02:00:00.000Z" }] },
    ]);
    const oversized = config(() => Response.json({ calendars: { room: { busy: [] } }, padding: "x".repeat(300_000) }));
    await assert.rejects(() => queryGoogleBusyByCalendar(oversized, "token", ["room"], "2026-11-01T00:00:00Z", "2026-11-02T00:00:00Z"), GoogleCalendarError);
  });

  it("creates a bounded HTTPS watch without sending calendar event fields", async () => {
    const id = "00000000-0000-4000-8000-000000000123";
    const expiresAtUtc = new Date(Date.now() + 86_400_000).toISOString();
    let payload: Record<string, unknown> | undefined;
    const grant = config((url, init) => {
      assert.match(url, /\/calendars\/private\/events\/watch$/);
      payload = JSON.parse(String(init.body));
      return Response.json({ id, resourceId: "opaque-google-resource", expiration: String(Date.parse(expiresAtUtc)) });
    });
    const result = await watchGoogleCalendar(grant, "token", { id, calendarId: "private", address: "https://experience.example.test/api/google/calendar/watch", token: "t".repeat(40), expiresAtUtc });
    assert.equal(result.resourceId, "opaque-google-resource");
    assert.deepEqual(Object.keys(payload!).sort(), ["address", "expiration", "id", "token", "type"]);
    assert.equal("summary" in payload!, false);
  });

  it("writes a booking under a stable private event ID: updates first, inserts when missing, restores a deleted one", async () => {
    const events = new Map<string, { status: string; body: Record<string, unknown> }>();
    const seen: { method: string; url: string; body?: Record<string, unknown> }[] = [];
    const grant = config((url, init) => {
      const method = String(init.method);
      const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      seen.push({ method, url, ...(body ? { body } : {}) });
      const id = decodeURIComponent(url.split("/events")[1]?.replace(/^\//, "") ?? "");
      if (method === "PUT") {
        if (!events.has(id)) return new Response(null, { status: 404 });
        events.set(id, { status: String(body!.status), body: body! });
        return Response.json({ id });
      }
      if (method === "POST") {
        if (events.has(String(body!.id))) return new Response(null, { status: 409 });
        events.set(String(body!.id), { status: "confirmed", body: body! });
        return Response.json({ id: body!.id });
      }
      if (method === "DELETE") {
        if (!events.has(id) || events.get(id)!.status === "cancelled") return new Response(null, { status: 410 });
        events.get(id)!.status = "cancelled";
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 500 });
    });
    const booking = { id: "8d4f5d55-8c5d-4c1d-9c55-0d1f2c3b4a5e", title: "Tea ceremony (2)", startUtc: "2026-11-01T01:00:00Z", endUtc: "2026-11-01T02:00:00Z" };
    const first = await writeConfirmedBooking(grant, "token", "booking-calendar", booking);
    assert.match(first, /^[0-9a-v]{5,1024}$/);
    assert.deepEqual(seen.map((item) => item.method), ["PUT", "POST"]);
    const sent = seen[1]!.body!;
    assert.deepEqual(Object.keys(sent).sort(), ["end", "id", "start", "status", "summary", "transparency", "visibility"]);
    assert.equal(sent.visibility, "private");
    assert.deepEqual(sent.start, { dateTime: "2026-11-01T01:00:00.000Z" });
    assert.equal(await writeConfirmedBooking(grant, "token", "booking-calendar", { ...booking, startUtc: "2026-11-01T03:00:00Z", endUtc: "2026-11-01T04:00:00Z" }), first);
    assert.deepEqual(events.get(first)!.body.start, { dateTime: "2026-11-01T03:00:00.000Z" });
    await removeBookingEvent(grant, "token", "booking-calendar", booking.id);
    await removeBookingEvent(grant, "token", "booking-calendar", booking.id);
    assert.equal(events.get(first)!.status, "cancelled");
    assert.equal(await writeConfirmedBooking(grant, "token", "booking-calendar", booking), first);
    assert.equal(events.get(first)!.status, "confirmed");
    assert.ok(seen.every((item) => item.url.startsWith("https://www.googleapis.com/calendar/v3/calendars/booking-calendar/events")));
  });

  it("updates after an insert conflict and maps a refused token to REVOKED", async () => {
    let puts = 0;
    const raced = config((url, init) => {
      if (init.method === "PUT") return (puts += 1) === 1 ? new Response(null, { status: 404 }) : Response.json({ id: url.split("/").at(-1) });
      return new Response(null, { status: 409 });
    });
    const booking = { id: "booking_123", title: "予約", startUtc: "2026-11-01T01:00:00Z", endUtc: "2026-11-01T02:00:00Z" };
    assert.match(await writeConfirmedBooking(raced, "token", "booking-calendar", booking), /^[0-9a-v]+$/);
    assert.equal(puts, 2);
    const wrongId = config(() => Response.json({ id: "someone-else" }));
    await assert.rejects(writeConfirmedBooking(wrongId, "token", "booking-calendar", booking), (error: unknown) => error instanceof GoogleCalendarError && error.reason === "INVALID_RESPONSE");
    const refused = config(() => new Response(null, { status: 401 }));
    await assert.rejects(writeConfirmedBooking(refused, "token", "booking-calendar", booking), (error: unknown) => error instanceof GoogleCalendarError && error.reason === "REVOKED");
    await assert.rejects(removeBookingEvent(refused, "token", "booking-calendar", booking.id), (error: unknown) => error instanceof GoogleCalendarError && error.reason === "REVOKED");
    await assert.rejects(writeConfirmedBooking(refused, "token", "booking-calendar", { ...booking, endUtc: booking.startUtc }), TypeError);
  });

  it("creates the dedicated Airbnb calendar at the fixed path with only server summary and timezone", async () => {
    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    const grant = config((url, init) => {
      seenUrl = url; seenInit = init;
      return Response.json({ id: "opaque-airbnb-calendar", summary: "ignored", accessRole: "owner" });
    });
    assert.equal(await createAirbnbOutputCalendar(grant, "access", "NIHO Airbnb | Synthetic tea"), "opaque-airbnb-calendar");
    assert.equal(seenUrl, "https://www.googleapis.com/calendar/v3/calendars");
    assert.equal(seenInit?.method, "POST");
    assert.equal(seenInit?.redirect, "manual");
    assert.equal((seenInit?.headers as Record<string, string>).authorization, "Bearer access");
    assert.deepEqual(JSON.parse(String(seenInit?.body)), { summary: "NIHO Airbnb | Synthetic tea", timeZone: "Asia/Tokyo" });
    assert.deepEqual(GOOGLE_SCOPES, [
      "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
      "https://www.googleapis.com/auth/calendar.events.freebusy",
      "https://www.googleapis.com/auth/calendar.app.created",
    ]);
  });

  it("rejects redirects, server failures, invalid IDs, and an unbounded summary without leaking bodies", async () => {
    for (const response of [
      new Response(null, { status: 302, headers: { location: "https://evil.example" } }),
      Response.json({ error: { message: "secret-google-error" } }, { status: 500 }),
      Response.json({ id: "" }),
      Response.json({ id: "x".repeat(513) }),
      Response.json({ id: "bad id" }),
    ]) {
      await assert.rejects(
        () => createAirbnbOutputCalendar(config(() => response.clone()), "access", "NIHO Airbnb | Synthetic"),
        (error: unknown) => error instanceof GoogleCalendarError && !error.message.includes("secret-google-error"),
      );
    }
    await assert.rejects(
      () => createAirbnbOutputCalendar(config(() => Response.json({ id: "unused" })), "access", "x".repeat(201)),
      TypeError,
    );
  });

  it("applies the shared ten-second deadline to create", { timeout: 15_000 }, async () => {
    let calls = 0;
    const hanging = config((_url, init) => new Promise<Response>((_resolve, reject) => {
      calls += 1;
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    const started = Date.now();
    await assert.rejects(() => createAirbnbOutputCalendar(hanging, "access", "NIHO Airbnb | Synthetic"), GoogleCalendarError);
    assert.equal(calls, 1);
    assert.ok(Date.now() - started >= 9_500);
  });
});
