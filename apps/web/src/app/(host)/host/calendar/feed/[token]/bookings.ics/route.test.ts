import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { HostCalendarFeed } from "@niho-experience/experience-store";

/** 設定 › カレンダー's bookings feed route (#109), against a stubbed store and synthetic bookings. */
const state = vi.hoisted(() => ({
  config: { hostConsoleEnabled: true, hostCalendarFeedEnabled: true },
  mock: false,
  readFeed: null as null | Mock<(hash: Buffer, window: { fromUtc: string; toUtc: string }) => Promise<HostCalendarFeed | null>>,
  store: true,
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: state.config }));
vi.mock("@/lib/experience/store-server", () => ({ hostCalendarSettings: () => (state.store ? { readFeed: state.readFeed } : null) }));
vi.mock("@/lib/experience/google-connection", () => ({ googleRuntimeConfig: () => null }));
vi.mock("@/lib/host/provider-operations-server", () => ({ providerOperationsEnabled: () => false }));
vi.mock("@/lib/host/server", () => ({ isHostMock: () => state.mock, siteOrigin: () => "https://experience.example" }));

import nextConfig from "../../../../../../../../next.config";
import { GET } from "./route";

const TOKEN = "Abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE";
const FEED: HostCalendarFeed = {
  providerId: "sample-provider",
  bookings: [{
    bookingId: "41", productId: "sample-walk", offerId: "sample-walk-am", productTitle: "Synthetic walk",
    startUtc: "2026-11-05T01:00:00.000Z", endUtc: "2026-11-05T02:30:00.000Z", localDate: "2026-11-05", localStartTime: "10:00", seats: 3,
  }],
};

const get = (token: string) => GET(new Request(`https://experience.example/host/calendar/feed/${token}/bookings.ics`), { params: Promise.resolve({ token }) });
const consoles = () => (["log", "info", "warn", "error", "debug"] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => undefined));

beforeEach(() => {
  vi.useFakeTimers({ now: new Date("2026-11-01T03:00:00.000Z"), toFake: ["Date"] });
  state.config.hostConsoleEnabled = true;
  state.config.hostCalendarFeedEnabled = true;
  state.mock = false;
  state.store = true;
  state.readFeed = vi.fn(async () => FEED);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function expectPrivate(response: Response) {
  expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
  expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow, noarchive");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
}

describe("the bookings feed route", () => {
  it("answers the provider's bookings as a private calendar file, read by the address's digest over the window", async () => {
    const response = await get(TOKEN);
    expect(response.status).toBe(200);
    expectPrivate(response);
    expect(response.headers.get("content-type")).toBe("text/calendar; charset=utf-8");
    expect(response.headers.get("content-disposition")).toBe('inline; filename="bookings.ics"');
    const body = await response.text();
    expect(body).toMatch(/^BEGIN:VCALENDAR\r\n/);
    expect(body).toContain("SUMMARY:Synthetic walk（3名）");
    expect(body).not.toContain(TOKEN);
    const [hash, window] = state.readFeed!.mock.calls[0]!;
    expect(hash).toEqual(createHash("sha256").update(TOKEN).digest());
    // 30 days before today in Japan (2026-11-01) to 400 days after, from midnight in Japan.
    expect(window).toEqual({ fromUtc: "2026-10-01T15:00:00.000Z", toUtc: "2027-12-05T15:00:00.000Z" });
  });

  it("answers the same empty 404 for every miss", async () => {
    const misses: Response[] = [];
    state.readFeed!.mockResolvedValueOnce(null);
    misses.push(await get(TOKEN));
    for (const token of ["short", `${TOKEN}A`, "Abcdefghijklmnopqrstuvwxyz0123456789_-ABC.E", "Abcdefghijklmnopqrstuvwxyz0123456789_-ABC%2F"]) misses.push(await get(token));
    state.config.hostCalendarFeedEnabled = false;
    misses.push(await get(TOKEN));
    state.config.hostCalendarFeedEnabled = true;
    state.mock = true;
    misses.push(await get(TOKEN));
    state.mock = false;
    state.config.hostConsoleEnabled = false;
    misses.push(await get(TOKEN));
    for (const response of misses) {
      expect(response.status).toBe(404);
      expectPrivate(response);
      expect(await response.text()).toBe("");
    }
    // Only the well-formed address with everything on reached the store.
    expect(state.readFeed).toHaveBeenCalledTimes(1);
  });

  it("says 503 without a body when the store fails, logging the error's name and never the address", async () => {
    const logged = consoles();
    state.readFeed!.mockRejectedValueOnce(Object.assign(new Error(`connection to ${TOKEN} failed`), { name: "DatabaseError" }));
    const failed = await get(TOKEN);
    expect(failed.status).toBe(503);
    expectPrivate(failed);
    expect(await failed.text()).toBe("");
    expect(console.error).toHaveBeenCalledWith("Experience calendar feed read failed", { error: "DatabaseError" });
    state.store = false;
    expect((await get(TOKEN)).status).toBe(503);
    await get(TOKEN.slice(1));
    for (const spy of logged) for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toContain(TOKEN);
  });

  it("keeps the deployment's headers for the path the same as the route's (they win over the route's own)", async () => {
    const rules = await nextConfig.headers!();
    const feed = rules.find((rule) => rule.source === "/host/calendar/feed/:path+");
    const host = rules.findIndex((rule) => rule.source === "/host/:path+");
    expect(rules.indexOf(feed!)).toBeGreaterThan(host);
    expect(feed?.headers).toEqual([
      { key: "Cache-Control", value: "private, no-store, max-age=0" },
      { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
      { key: "Referrer-Policy", value: "no-referrer" },
    ]);
  });
});
