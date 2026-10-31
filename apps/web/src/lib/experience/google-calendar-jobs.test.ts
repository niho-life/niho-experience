import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BookingCalendarWork } from "@niho-experience/experience-store";

const mocks = vi.hoisted(() => ({
  config: {
    googleBusySyncEnabled: true,
    googleBookingEventsEnabled: false,
    googleJobsAudience: "https://experience.example/internal/google-calendar",
    googleJobsServiceAccountEmail: "google-calendar-job@example.iam.gserviceaccount.com",
  },
  runtime: vi.fn(),
  pool: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: mocks.config }));
vi.mock("@/lib/experience/store-server", () => ({ experiencePool: mocks.pool }));
vi.mock("./google-connection", () => ({
  googleRuntimeConfig: mocks.runtime, googleAccessTokenForConnection: vi.fn(), syncOneDueProviderGoogle: vi.fn(),
}));
vi.mock("./resource-google", () => ({ syncOneDueResourceGoogleAsScheduler: vi.fn() }));

import type { GoogleServiceTokenVerifier } from "@/lib/google-service-identity";
import * as bookingEventsRoute from "@/app/internal/google-calendar/v1/booking-events/route";
import * as busySyncRoute from "@/app/internal/google-calendar/v1/busy-sync/route";
import { googleBookingEventsResponse, googleBusySyncResponse, runGoogleBookingEvents, runGoogleBusySync } from "./google-calendar-jobs";

const counts = { providerReads: 2, providerFailed: 1, resourceReads: 3, resourceFailed: 0 };
const fakePool = { query: vi.fn() };
const request = (headers: Record<string, string> = { authorization: "Bearer synthetic.jwt.token" }) =>
  new Request("https://experience.example/internal/google-calendar/v1/busy-sync", { method: "POST", headers });
const verifier = (result: Awaited<ReturnType<GoogleServiceTokenVerifier["verify"]>>): GoogleServiceTokenVerifier => ({ verify: vi.fn(async () => result) });
const valid = verifier({ ok: true, claims: {
  iss: "https://accounts.google.com", aud: mocks.config.googleJobsAudience, email: mocks.config.googleJobsServiceAccountEmail,
  emailVerified: true, exp: Math.floor(Date.now() / 1000) + 300,
} });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.runtime.mockReturnValue({ google: {}, key: Buffer.alloc(32) });
  mocks.pool.mockReturnValue(fakePool);
});

describe("Google calendar job triggers", () => {
  it("export POST only, on the Node runtime", () => {
    for (const route of [busySyncRoute, bookingEventsRoute]) {
      expect(Object.keys(route).sort()).toEqual(["POST", "dynamic", "runtime"]);
      expect(route.runtime).toBe("nodejs");
    }
  });

  it("is 404 before identity while its flag is off, and each job has its own flag", async () => {
    const busySync = vi.fn(async () => counts);
    const bookingEvents = vi.fn();
    expect((await googleBookingEventsResponse(request(), { verifier: valid, bookingEvents })).status).toBe(404);
    expect(valid.verify).not.toHaveBeenCalled();
    expect(bookingEvents).not.toHaveBeenCalled();
    expect((await googleBusySyncResponse(request(), { verifier: valid, busySync })).status).toBe(200);
  });

  it("accepts only the scheduler's service identity, and is 503 when Google's keys, the DB or the OAuth client are missing", async () => {
    const busySync = vi.fn(async () => counts);
    expect((await googleBusySyncResponse(request({}), { verifier: valid, busySync })).status).toBe(401);
    const other = verifier({ ok: true, claims: { iss: "https://accounts.google.com", aud: mocks.config.googleJobsAudience, email: "other@example.iam.gserviceaccount.com", emailVerified: true, exp: Math.floor(Date.now() / 1000) + 300 } });
    expect((await googleBusySyncResponse(request(), { verifier: other, busySync })).status).toBe(401);
    expect((await googleBusySyncResponse(request(), { verifier: verifier({ ok: false, kind: "outage" }), busySync })).status).toBe(503);
    mocks.pool.mockReturnValueOnce(null);
    expect((await googleBusySyncResponse(request(), { verifier: valid, busySync })).status).toBe(503);
    mocks.runtime.mockReturnValueOnce(null);
    expect((await googleBusySyncResponse(request(), { verifier: valid, busySync })).status).toBe(503);
    expect(busySync).not.toHaveBeenCalled();
  });

  it("answers the counts uncached, and a failed run with 503 and no database message", async () => {
    const response = await googleBusySyncResponse(request(), { verifier: valid, busySync: async () => counts });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual(counts);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const failed = await googleBusySyncResponse(request(), { verifier: valid, busySync: async () => { throw new Error("duplicate key (provider-a, cal-secret)"); } });
    expect(failed.status).toBe(503);
    expect(JSON.stringify(error.mock.calls)).not.toMatch(/provider-a|cal-secret/);
    error.mockRestore();
  });
});

describe("runGoogleBusySync", () => {
  it("reads the provider-wide inputs, then the resources, until none is due, the limits or the time budget", async () => {
    const provider = vi.fn().mockResolvedValueOnce({ applied: true }).mockResolvedValueOnce({ applied: false }).mockResolvedValueOnce(null);
    const resource = vi.fn().mockResolvedValue({ processed: true, applied: true });
    expect(await runGoogleBusySync({ syncProvider: provider, syncResource: resource, now: () => 0, limits: { providerReads: 5, resourceReads: 2, budgetMs: 1_000 } }))
      .toEqual({ providerReads: 2, providerFailed: 1, resourceReads: 2, resourceFailed: 0 });
    let clock = 0;
    const slow = vi.fn(async () => { clock += 600; return { applied: true }; });
    const counted = await runGoogleBusySync({ syncProvider: slow, syncResource: resource, now: () => clock, limits: { providerReads: 5, resourceReads: 5, budgetMs: 1_000 } });
    expect(counted.providerReads).toBe(2);
    expect(counted.resourceReads).toBe(0);
  });
});

describe("runGoogleBookingEvents", () => {
  const work = (providerId: string, action: "WRITE" | "REMOVE", bookingId: string): BookingCalendarWork => ({
    claimId: `claim-${bookingId}`, providerId, bookingId, publicBookingId: `public-${bookingId}`, connectionGeneration: 1,
    calendarId: "booking", action, title: "Tea（2名）", startUtc: "2099-01-01T01:00:00.000Z", endUtc: "2099-01-01T02:00:00.000Z", attempts: 1,
  });

  it("asks for one token per provider and run, and records each booking's outcome", async () => {
    const queue = [work("provider-a", "WRITE", "1"), work("provider-a", "REMOVE", "2"), work("provider-b", "WRITE", "3"), work("provider-c", "WRITE", "4")];
    const events = { claimDue: vi.fn(async () => queue.splice(0, 1)), finish: vi.fn<(work: BookingCalendarWork, outcome: string) => Promise<boolean>>(async () => true) };
    const accessToken = vi.fn(async (providerId: string) => {
      if (providerId === "provider-b") throw new Error("refused");
      return providerId === "provider-c" ? null : "token-a";
    });
    const write = vi.fn(async () => {});
    const remove = vi.fn(async () => {});
    expect(await runGoogleBookingEvents({ events, accessToken, write, remove, now: () => 0 })).toEqual({ claimed: 4, written: 1, removed: 1, failed: 2 });
    expect(accessToken).toHaveBeenCalledTimes(3);
    expect(events.finish.mock.calls.map(([item, outcome]) => `${item.bookingId}:${outcome}`)).toEqual(["1:WRITTEN", "2:REMOVED", "3:FAILED", "4:FAILED"]);
    expect(write).toHaveBeenCalledWith("token-a", expect.objectContaining({ bookingId: "1" }));
  });
});
