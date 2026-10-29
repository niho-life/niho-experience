import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GOOGLE_SCOPES, GoogleCalendarError, googleAuthorizationUrl, queryGoogleBusy, queryGoogleBusyByCalendar, refreshGoogleToken, watchGoogleCalendar, writeConfirmedBooking, type GoogleConfig } from "../src/index.ts";

const base = { clientId: "synthetic-client", clientSecret: "synthetic-secret", redirectUri: "https://experience.example.test/host/calendar/google/callback" };

function config(respond: (url: string, init: RequestInit) => Response): GoogleConfig {
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

  it("uses a stable private event ID and treats a retry conflict as written", async () => {
    const payloads: Record<string, unknown>[] = [];
    const grant = config((_url, init) => { payloads.push(JSON.parse(String(init.body))); return new Response(null, { status: 409 }); });
    const booking = { id: "booking_123", title: "予約", startUtc: "2026-11-01T01:00:00Z", endUtc: "2026-11-01T02:00:00Z" };
    const first = await writeConfirmedBooking(grant, "token", "booking-calendar", booking);
    const second = await writeConfirmedBooking(grant, "token", "booking-calendar", booking);
    assert.equal(first, second);
    assert.match(first, /^[0-9a-v]{5,1024}$/);
    assert.equal(payloads[0]?.visibility, "private");
    assert.equal("attendees" in payloads[0]!, false);
  });
});
