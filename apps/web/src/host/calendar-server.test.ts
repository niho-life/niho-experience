import { createHash, createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { StoreAccessDeniedError, StoreError, type HostGoogleConnectionState } from "@niho-experience/experience-store";

/** 設定 › カレンダー in http mode (#109): the feed's address and what the panel reads, against a stubbed store. */
type Fn = Mock<(...args: unknown[]) => Promise<unknown>>;
const state = vi.hoisted(() => ({
  mock: false,
  config: { hostCalendarFeedEnabled: true },
  google: true,
  store: null as null | { googleConnection: Fn; getFeed: Fn; issueFeed: Fn; revokeFeed: Fn },
  session: { nihoUserId: "sample-owner", idTokenExpiresAt: Number.MAX_SAFE_INTEGER } as null | { nihoUserId: string; idTokenExpiresAt: number },
  providers: { status: "ok", providers: [{ id: "sample-provider", memberRole: "OWNER" }] } as { status: string; providers?: { id: string; memberRole: string }[] },
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: state.config }));
vi.mock("@/lib/experience/google-connection", () => ({ googleRuntimeConfig: () => (state.google ? { google: {}, key: Buffer.alloc(32) } : null) }));
vi.mock("@/lib/experience/store-server", () => ({ hostCalendarSettings: () => state.store }));
vi.mock("@/lib/host/server", () => ({
  isHostMock: () => state.mock,
  siteOrigin: () => "https://experience.example",
  readHostSession: async () => state.session,
  loadHostProviders: async () => state.providers,
}));
vi.mock("@/lib/host/session", () => ({ idTokenUsable: (session: { idTokenExpiresAt: number }, now: number) => session.idTokenExpiresAt > now }));

import { CALENDAR_FEED_ISSUED_TEXT, CALENDAR_FEED_OWNER_ONLY_TEXT, CALENDAR_FEED_RENEWED_TEXT, CALENDAR_FEED_REVOKED_TEXT, GOOGLE_NOT_CONNECTED } from "./calendar";
import { calendarFeedToken, calendarFeedTokenHash, calendarFeedTokenMatches, calendarFeedUrl, issueCalendarFeedAsOwner, loadHostCalendar, revokeCalendarFeedAsOwner } from "./calendar-server";
import { HOST_SESSION_ENDED_TEXT } from "./errors";

const KEY = Buffer.alloc(32, 7);
const SALT = Buffer.alloc(32, 1);
const OWNER = { id: "sample-provider", memberRole: "OWNER" } as const;
const ACTOR = { providerId: "sample-provider", nihoUserId: "sample-owner", calendarRoleCeiling: "OWNER" };
const CONNECTED: HostGoogleConnectionState = { revoked: false, blockingEnabled: true, syncStatus: "FRESH", lastSucceededAtUtc: "2026-11-01T01:05:30.000Z" };
/** The address for the provider and salt under `key`, and what the store keeps of it. */
const tokenUnder = (key: Buffer, salt: Buffer = SALT, providerId = "sample-provider") => createHmac("sha256", key).update(`niho-experience/calendar-feed/v1\0${providerId}\0`).update(salt).digest("base64url");
const issuedUnder = (key: Buffer, salt: Buffer = SALT) => ({ salt, tokenHash: createHash("sha256").update(tokenUnder(key, salt)).digest(), issuedAtUtc: "2026-10-30T00:00:00.000Z" });

beforeEach(() => {
  vi.stubEnv("EXPERIENCE_CALENDAR_FEED_KEY", KEY.toString("base64"));
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  state.mock = false;
  state.config.hostCalendarFeedEnabled = true;
  state.google = true;
  state.session = { nihoUserId: "sample-owner", idTokenExpiresAt: Number.MAX_SAFE_INTEGER };
  state.providers = { status: "ok", providers: [{ id: "sample-provider", memberRole: "OWNER" }] };
  state.store = {
    googleConnection: vi.fn(async () => CONNECTED),
    getFeed: vi.fn(async () => issuedUnder(KEY)),
    issueFeed: vi.fn(async () => ({ issuedAtUtc: "2026-11-01T00:00:00.000Z", replaced: false })),
    revokeFeed: vi.fn(async () => true),
  };
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("the feed's address", () => {
  it("is an HMAC of the provider and its salt under the key: the same for the same inputs, different otherwise", () => {
    const token = calendarFeedToken("sample-provider", SALT);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(token).toBe(createHmac("sha256", KEY).update("niho-experience/calendar-feed/v1\0sample-provider\0").update(SALT).digest("base64url"));
    expect(calendarFeedToken("sample-provider", SALT)).toBe(token);
    expect(calendarFeedToken("other-provider", SALT)).not.toBe(token);
    expect(calendarFeedToken("sample-provider", Buffer.alloc(32, 2))).not.toBe(token);
    vi.stubEnv("EXPERIENCE_CALENDAR_FEED_KEY", Buffer.alloc(32, 8).toString("base64"));
    expect(calendarFeedToken("sample-provider", SALT)).not.toBe(token);
  });

  it("is found by its SHA-256, and lives under the host calendar path", () => {
    const token = calendarFeedToken("sample-provider", SALT);
    expect(calendarFeedTokenHash(token)).toEqual(createHash("sha256").update(token).digest());
    expect(calendarFeedTokenHash(token).byteLength).toBe(32);
    expect(calendarFeedUrl(token)).toBe(`https://experience.example/host/calendar/feed/${token}/bookings.ics`);
  });

  it("is not made without a usable key", () => {
    for (const key of ["", "c2hvcnQ=", "not base64!"]) {
      vi.stubEnv("EXPERIENCE_CALENDAR_FEED_KEY", key);
      expect(() => calendarFeedToken("sample-provider", SALT)).toThrow(/key is unavailable/);
      expect(() => calendarFeedTokenMatches(tokenUnder(KEY), { providerId: "sample-provider", salt: SALT })).toThrow(/key is unavailable/);
    }
  });

  it("is accepted only as the current key derives it for the issue found: not under an earlier key, another salt or provider, or changed", () => {
    const issue = { providerId: "sample-provider", salt: SALT };
    const token = tokenUnder(KEY);
    expect(calendarFeedTokenMatches(token, issue)).toBe(true);
    expect(calendarFeedTokenMatches(token, { ...issue, salt: Buffer.alloc(32, 2) })).toBe(false);
    expect(calendarFeedTokenMatches(token, { ...issue, providerId: "other-provider" })).toBe(false);
    expect(calendarFeedTokenMatches(`${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`, issue)).toBe(false);
    // Another length is refused before the constant-time compare (which needs equal lengths).
    expect(calendarFeedTokenMatches(token.slice(1), issue)).toBe(false);
    expect(calendarFeedTokenMatches("", issue)).toBe(false);
    vi.stubEnv("EXPERIENCE_CALENDAR_FEED_KEY", Buffer.alloc(32, 8).toString("base64"));
    expect(calendarFeedTokenMatches(token, issue)).toBe(false);
    expect(calendarFeedTokenMatches(tokenUnder(Buffer.alloc(32, 8)), issue)).toBe(true);
  });
});

describe("loadHostCalendar", () => {
  it("reads the Google connection and, for 設定, the feed's address as the OWNER", async () => {
    const load = await loadHostCalendar(OWNER, "sample-owner", { feed: true });
    expect(state.store!.googleConnection).toHaveBeenCalledWith(ACTOR);
    expect(state.store!.getFeed).toHaveBeenCalledWith(ACTOR);
    expect(load).toEqual({
      status: "live",
      google: { ...GOOGLE_NOT_CONNECTED, status: "connected", blockBusy: true },
      googleSync: { lastCheckedAt: "2026-11-01T10:05", failing: false },
      feed: { url: calendarFeedUrl(calendarFeedToken("sample-provider", SALT)) },
    });
  });

  it("shows no address once the key changed since it was issued (it stopped), and the new one once the OWNER makes it", async () => {
    const rotated = Buffer.alloc(32, 8);
    vi.stubEnv("EXPERIENCE_CALENDAR_FEED_KEY", rotated.toString("base64"));
    expect(await loadHostCalendar(OWNER, "sample-owner", { feed: true })).toMatchObject({ status: "live", feed: { url: null } });

    state.store!.issueFeed.mockResolvedValueOnce({ issuedAtUtc: "2026-11-01T00:00:00.000Z", replaced: true });
    const renewed = await issueCalendarFeedAsOwner("sample-provider");
    const [, input] = state.store!.issueFeed.mock.calls[0]! as [unknown, { salt: Buffer; tokenHash: Buffer }];
    const token = tokenUnder(rotated, input.salt);
    expect(input.tokenHash).toEqual(createHash("sha256").update(token).digest());
    expect(renewed).toEqual({ ok: true, message: CALENDAR_FEED_RENEWED_TEXT, url: calendarFeedUrl(token) });
    state.store!.getFeed.mockResolvedValueOnce(issuedUnder(rotated, input.salt));
    expect(await loadHostCalendar(OWNER, "sample-owner", { feed: true })).toMatchObject({ feed: { url: calendarFeedUrl(token) } });
    // A stored digest of another length (never written by issueFeed) is no address either.
    state.store!.getFeed.mockResolvedValueOnce({ ...issuedUnder(rotated, input.salt), tokenHash: Buffer.alloc(16) });
    expect(await loadHostCalendar(OWNER, "sample-owner", { feed: true })).toMatchObject({ feed: { url: null } });
  });

  it("says not connected, refused by Google, or connected with failing reads", async () => {
    state.store!.googleConnection.mockResolvedValueOnce(null);
    expect(await loadHostCalendar(OWNER, "sample-owner", { feed: false })).toEqual({ status: "live", google: GOOGLE_NOT_CONNECTED, googleSync: null, feed: null });
    state.store!.googleConnection.mockResolvedValueOnce({ ...CONNECTED, revoked: true, syncStatus: "FAILED" });
    expect(await loadHostCalendar(OWNER, "sample-owner", { feed: false })).toMatchObject({ google: { status: "revoked" }, googleSync: null });
    state.store!.googleConnection.mockResolvedValueOnce({ ...CONNECTED, syncStatus: "FAILED", blockingEnabled: false, lastSucceededAtUtc: null });
    expect(await loadHostCalendar(OWNER, "sample-owner", { feed: false })).toMatchObject({ google: { status: "connected", blockBusy: false }, googleSync: { lastCheckedAt: null, failing: true } });
  });

  it("has no Google row without Google's sign-in, no feed without its flag or outside 設定, and no address before one is made", async () => {
    state.google = false;
    expect(await loadHostCalendar(OWNER, "sample-owner", { feed: true })).toMatchObject({ status: "live", google: null, googleSync: null });
    expect(state.store!.googleConnection).toHaveBeenCalled();
    state.store!.getFeed.mockClear();
    expect(await loadHostCalendar(OWNER, "sample-owner", { feed: false })).toMatchObject({ feed: null });
    state.config.hostCalendarFeedEnabled = false;
    expect(await loadHostCalendar(OWNER, "sample-owner", { feed: true })).toMatchObject({ feed: null });
    expect(state.store!.getFeed).not.toHaveBeenCalled();
    state.config.hostCalendarFeedEnabled = true;
    state.store!.getFeed.mockResolvedValueOnce(null);
    expect(await loadHostCalendar(OWNER, "sample-owner", { feed: true })).toMatchObject({ feed: { url: null } });
  });

  it("is closed in the preview, for anyone else, without the store, and when the store does not count them as the OWNER", async () => {
    expect(await loadHostCalendar({ id: "sample-provider", memberRole: "EDITOR" }, "sample-owner", { feed: true })).toEqual({ status: "closed" });
    state.store!.googleConnection.mockRejectedValueOnce(new StoreAccessDeniedError());
    expect(await loadHostCalendar(OWNER, "sample-owner", { feed: true })).toEqual({ status: "closed" });
    state.mock = true;
    expect(await loadHostCalendar(OWNER, "sample-owner", { feed: true })).toEqual({ status: "closed" });
    state.mock = false;
    state.store = null;
    expect(await loadHostCalendar(OWNER, "sample-owner", { feed: true })).toEqual({ status: "closed" });
  });

  it("says it could not read, logging no more than the error's name", async () => {
    state.store!.getFeed.mockRejectedValueOnce(new StoreError("Database returned an invalid feed_salt."));
    expect(await loadHostCalendar(OWNER, "sample-owner", { feed: true })).toEqual({ status: "error" });
    expect(console.error).toHaveBeenCalledWith("Experience host calendar read failed", { error: "StoreError" });
  });
});

describe("URL を作る / URL を止める", () => {
  it("issues a new address from a new salt, saying whether it replaced one", async () => {
    const first = await issueCalendarFeedAsOwner("sample-provider");
    const [actor, input] = state.store!.issueFeed.mock.calls[0]! as [unknown, { salt: Buffer; tokenHash: Buffer }];
    expect(actor).toEqual(ACTOR);
    expect(input.salt.byteLength).toBe(32);
    const token = calendarFeedToken("sample-provider", input.salt);
    expect(input.tokenHash).toEqual(calendarFeedTokenHash(token));
    expect(first).toEqual({ ok: true, message: CALENDAR_FEED_ISSUED_TEXT, url: calendarFeedUrl(token) });

    state.store!.issueFeed.mockResolvedValueOnce({ issuedAtUtc: "2026-11-01T00:00:00.000Z", replaced: true });
    const again = await issueCalendarFeedAsOwner("sample-provider");
    expect(again).toMatchObject({ ok: true, message: CALENDAR_FEED_RENEWED_TEXT });
    const salts = state.store!.issueFeed.mock.calls.map(([, value]) => (value as { salt: Buffer }).salt.toString("hex"));
    expect(new Set(salts).size).toBe(2);
  });

  it("stops the address", async () => {
    expect(await revokeCalendarFeedAsOwner("sample-provider")).toEqual({ ok: true, message: CALENDAR_FEED_REVOKED_TEXT, url: null });
    expect(state.store!.revokeFeed).toHaveBeenCalledWith(ACTOR);
  });

  it("is the OWNER's only, needs a usable session and the flag, and says when it failed", async () => {
    state.providers = { status: "ok", providers: [{ id: "sample-provider", memberRole: "EDITOR" }] };
    expect(await issueCalendarFeedAsOwner("sample-provider")).toEqual({ ok: false, message: CALENDAR_FEED_OWNER_ONLY_TEXT });
    expect(await issueCalendarFeedAsOwner("other-provider")).toEqual({ ok: false, message: CALENDAR_FEED_OWNER_ONLY_TEXT });
    state.providers = { status: "ok", providers: [{ id: "sample-provider", memberRole: "OWNER" }] };
    state.store!.revokeFeed.mockRejectedValueOnce(new StoreAccessDeniedError());
    expect(await revokeCalendarFeedAsOwner("sample-provider")).toEqual({ ok: false, message: CALENDAR_FEED_OWNER_ONLY_TEXT });
    state.store!.issueFeed.mockRejectedValueOnce(new Error("down"));
    expect(await issueCalendarFeedAsOwner("sample-provider")).toEqual({ ok: false, message: "URL を作れませんでした。時間をおいて、もう一度お試しください。" });
    expect(console.error).toHaveBeenCalledWith("Experience calendar feed issue failed", { error: "Error" });
    state.store!.revokeFeed.mockRejectedValueOnce(new Error("down"));
    expect(await revokeCalendarFeedAsOwner("sample-provider")).toEqual({ ok: false, message: "URL を止められませんでした。時間をおいて、もう一度お試しください。" });

    state.session = null;
    expect(await issueCalendarFeedAsOwner("sample-provider")).toEqual({ ok: false, message: HOST_SESSION_ENDED_TEXT });
    state.session = { nihoUserId: "sample-owner", idTokenExpiresAt: Number.MAX_SAFE_INTEGER };
    state.config.hostCalendarFeedEnabled = false;
    expect(await issueCalendarFeedAsOwner("sample-provider")).toMatchObject({ ok: false });
    state.config.hostCalendarFeedEnabled = true;
    state.mock = true;
    expect(await revokeCalendarFeedAsOwner("sample-provider")).toMatchObject({ ok: false });
    expect(state.store!.issueFeed).toHaveBeenCalledTimes(1);
    expect(state.store!.revokeFeed).toHaveBeenCalledTimes(2);
  });
});
