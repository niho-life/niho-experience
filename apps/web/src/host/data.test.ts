import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostProvider } from "@/lib/host/providers";
import type { HostMockScenario } from "@/lib/host/session";

/** The console's data entry point against the contract mock (mock) and a stubbed NIHO (http). */
const state = vi.hoisted(() => ({
  config: { apiMode: "mock" as "mock" | "http", nihoWebOrigin: "https://niho.example.test" },
  providers: [] as HostProvider[],
  scenario: "default" as HostMockScenario,
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: state.config, isPreview: true }));
// The real hostApiClient (typed client + contract mock, or the global fetch in http mode); only the session and the list are stubbed.
vi.mock("@/lib/host/server", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/host/server")>();
  const now = Date.now();
  const session = { refreshToken: "r", idToken: "mock-id-token.data-test", idTokenExpiresAt: now + 3_600_000, connectionId: "c", connectionExpiresAt: now + 86_400_000, expiresAt: now + 86_400_000, displayName: "サンプル ホスト", iconUrl: null };
  return {
    ...actual,
    readHostSession: async () => ({ ...session, mockScenario: state.scenario }),
    loadHostProviders: async () => ({ status: "ok", providers: state.providers }),
  };
});

import { PREVIEW_STRIPE_TEXT, STRIPE_LINK_UNUSABLE_TEXT, STRIPE_SYNCED_TEXT } from "./connect";
import { hostPageContext, loadHostBookings, loadHostConsoleData, loadHostMessages, loadHostPayout, loadHostReviews, loadHostSales, loadHostSession, loadRegistrationConsent } from "./data";
import { GOOGLE_NOT_CONNECTED } from "./calendar";
import { HOST_ERROR_REASON_TEXT } from "./errors";
import { MOCK_GOOGLE_CONNECTION } from "./mock/provider";
import { MOCK_SALES_PERIOD } from "./mock/sales";

/** A provider as the host contract shapes it (synthetic values). */
const provider = (fields: Pick<HostProvider, "id" | "displayName" | "memberRole"> & Partial<HostProvider>): HostProvider => ({
  ownerUserId: "sample-user",
  vesselSpotId: `${fields.id}-vessel`,
  kind: "INDIVIDUAL",
  bio: "",
  sellerDisclosureUrl: null,
  reviewStatus: "DRAFT",
  consentVersion: "sample-provider-consent-1",
  consentedAt: "2026-10-01T00:00:00.000Z",
  submittedAt: null,
  approvedAt: null,
  paymentReuseConsentVersion: null,
  paymentReuseConsentedAt: null,
  paymentReuseSourceSpotId: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  ...fields,
});

const KITCHEN = provider({ id: "sample-provider-kitchen", displayName: "サンプルの台所", memberRole: "OWNER", reviewStatus: "APPROVED" });
const STUDIO = provider({ id: "sample-provider-studio", displayName: "サンプル工房", memberRole: "EDITOR", kind: "BUSINESS" });
const GARDEN = provider({ id: "sample-provider-garden", displayName: "サンプルの庭", memberRole: "OWNER" });
const REUSE_CONSENT = { version: "sample-payment-reuse-consent-1", text: "（サンプル）拠点の販売者口座を、体験の売上の受取に使うことに同意します。この文言は合成データです。" };

const consent = { version: "sample-provider-consent-1", text: "合成の同意文" };
const detailBody = (detail: HostProvider) => ({ provider: detail, platformAdmin: false, consent, paymentReuseConsent: consent });

/** http mode: NIHO is the global fetch, recorded here. */
function stubNiho(respond: (url: string) => Response) {
  const calls: { url: string; authorization: string | null }[] = [];
  vi.stubGlobal("fetch", (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
    return respond(String(input));
  }) as typeof fetch);
  return calls;
}

/** 既定の集合案内 as NIHO answers it (synthetic). */
const MEETING = { overview: "（合成）駅の近く", address: "（合成）サンプル町 1 丁目", accessNote: "（合成）東口から歩きます。", mapUrl: "https://maps.example.test/sample", entranceNote: "（合成）木の門" };

beforeEach(() => {
  state.config.apiMode = "mock";
  state.providers = [KITCHEN, STUDIO];
  state.scenario = "default";
});
afterEach(() => vi.unstubAllGlobals());

describe("loadHostConsoleData", () => {
  it("mock: the contract mock's provider detail and the kitchen's preview data", async () => {
    const data = await loadHostConsoleData(KITCHEN);
    expect(data.settings).toEqual({
      displayName: "サンプルの台所",
      kind: "INDIVIDUAL",
      bio: "家庭料理を一緒に作る体験の、合成データの提供者です（sample）。",
      sellerDisclosureUrl: "https://example.com/sample-kitchen/legal",
      reviewStatus: "APPROVED",
      consentCurrent: true,
      meetingPoint: expect.objectContaining({ overview: "Near Kamakura Station, 5-minute walk", mapUrl: "https://maps.example.com/sample-kitchen" }),
      calendar: { google: expect.objectContaining({ status: "connected", account: "kitchen@example.com" }), icsUrl: expect.stringMatching(/^https:\/\/calendar\.example\.com\//) },
      notifications: { email: { addresses: ["kitchen@example.com"] }, items: expect.any(Array) },
    });
    expect(data.googleConnection).toBe(MOCK_GOOGLE_CONNECTION);
    expect(data.experiences).toHaveLength(3);
    expect(data.home.todos).toHaveLength(10);
  });

  it("mock: the notification settings are the owner's only, as NIHO answers them", async () => {
    const data = await loadHostConsoleData(STUDIO);
    expect(data.settings.notifications).toBeNull();
    expect(data.settings.calendar.google).toEqual(GOOGLE_NOT_CONNECTED);
  });

  it("mock: ?mock=calendar-revoked shows the kitchen's calendar as revoked", async () => {
    state.scenario = "calendar-revoked";
    expect((await loadHostConsoleData(KITCHEN)).settings.calendar.google).toMatchObject({ status: "revoked", account: "kitchen@example.com" });
  });

  it("mock: the studio is a business still in draft", async () => {
    const data = await loadHostConsoleData(STUDIO);
    expect(data.settings).toMatchObject({ displayName: "サンプル工房", kind: "BUSINESS", reviewStatus: "DRAFT", consentCurrent: true });
    expect(data.experiences.map((experience) => experience.status)).toEqual(["draft"]);
    expect(data.home.sessions).toEqual({ today: [], tomorrow: [], later: [] });
  });

  it("http: reads the provider detail and the meeting defaults from NIHO with the session's token and shows nothing else yet", async () => {
    state.config.apiMode = "http";
    const detail = provider({ id: KITCHEN.id, displayName: "合成の台所", memberRole: "OWNER", kind: "BUSINESS", bio: "合成の紹介", sellerDisclosureUrl: "https://seller.example.com/", reviewStatus: "REQUESTED" });
    const calls = stubNiho((url) => url.endsWith("/meeting-point") ? Response.json({ meetingPoint: MEETING }) : Response.json(detailBody(detail)));
    const data = await loadHostConsoleData(KITCHEN);
    expect(calls.toSorted((left, right) => left.url.localeCompare(right.url))).toEqual([
      { url: "https://niho.example.test/api/experience-providers/sample-provider-kitchen", authorization: "Bearer mock-id-token.data-test" },
      { url: "https://niho.example.test/api/experience-providers/sample-provider-kitchen/meeting-point", authorization: "Bearer mock-id-token.data-test" },
    ]);
    expect(data.settings).toEqual({
      displayName: "合成の台所",
      kind: "BUSINESS",
      bio: "合成の紹介",
      sellerDisclosureUrl: "https://seller.example.com/",
      reviewStatus: "REQUESTED",
      consentCurrent: true,
      meetingPoint: MEETING,
      calendar: { google: GOOGLE_NOT_CONNECTED, icsUrl: null },
      notifications: { email: { addresses: [] }, items: [] },
    });
    // Nothing to connect until NIHO's Google connection is in the host contract.
    expect(data.googleConnection).toBeNull();
    expect(data.experiences).toEqual([]);
    expect(data.home).toEqual({ todos: [], sessions: { today: [], tomorrow: [], later: [] }, month: null });
    // A provider who agreed to older terms cannot ask for the review until NIHO sorts it out.
    stubNiho(() => Response.json({ ...detailBody(detail), consent: { version: "sample-provider-consent-2", text: "新しい合成の同意文" } }));
    expect((await loadHostConsoleData(KITCHEN)).settings.consentCurrent).toBe(false);
  });

  it("http: falls back to the list's provider when the detail cannot be read", async () => {
    state.config.apiMode = "http";
    const fromList = { displayName: "サンプルの台所", kind: "INDIVIDUAL", bio: "", sellerDisclosureUrl: "", reviewStatus: "APPROVED" };
    stubNiho(() => new Response("unavailable", { status: 503 }));
    expect((await loadHostConsoleData(KITCHEN)).settings).toMatchObject(fromList);
    // A body outside the contract is not read.
    stubNiho(() => Response.json({ provider: { id: KITCHEN.id, displayName: "形の違う提供者" }, platformAdmin: false }));
    expect((await loadHostConsoleData(KITCHEN)).settings).toMatchObject(fromList);
    // A detail for another provider is not taken for this one.
    stubNiho(() => Response.json(detailBody(provider({ id: "someone-else", displayName: "別の提供者", memberRole: "OWNER", kind: "BUSINESS" }))));
    expect((await loadHostConsoleData(KITCHEN)).settings).toMatchObject(fromList);
  });

  it("http: the meeting defaults are the owner's and the editor's, null when NIHO cannot answer them", async () => {
    state.config.apiMode = "http";
    const editor = provider({ id: STUDIO.id, displayName: "サンプル工房", memberRole: "EDITOR" });
    stubNiho((url) => url.endsWith("/meeting-point") ? Response.json({ meetingPoint: MEETING }) : Response.json(detailBody(editor)));
    expect((await loadHostConsoleData(STUDIO)).settings.meetingPoint).toEqual(MEETING);
    stubNiho((url) => url.endsWith("/meeting-point") ? new Response("unavailable", { status: 503 }) : Response.json(detailBody(editor)));
    expect((await loadHostConsoleData(STUDIO)).settings.meetingPoint).toBeNull();
    // A cohost is not asked for: NIHO answers the meeting defaults to the owner and the editor only.
    const cohost = provider({ id: KITCHEN.id, displayName: "サンプルの台所", memberRole: "COHOST" });
    const calls = stubNiho(() => Response.json(detailBody(cohost)));
    expect((await loadHostConsoleData(cohost)).settings.meetingPoint).toBeNull();
    expect(calls.map((call) => call.url)).toEqual(["https://niho.example.test/api/experience-providers/sample-provider-kitchen"]);
  });
});

describe("loadHostBookings", () => {
  it("mock: the kitchen's bookings, the one ?booking= names, and the experiences without their pages", async () => {
    const data = await loadHostBookings(KITCHEN, "bk-2041");
    expect([data.today, data.now]).toEqual(["2026-10-21", "2026-10-21T15:30"]);
    expect(data.list.status === "ready" && data.list.bookings).toHaveLength(18);
    expect(data.requested).toMatchObject({ status: "ready", booking: { id: "bk-2041", guest: "Lucas & Mia Chen" } });
    expect(data.experiences[0]).toEqual({
      id: "community-dinner",
      title: "Kamakura Community Dinner with Locals",
      offers: [
        { id: "offer-dinner", capacity: 8, durationMinutes: 120 },
        { id: "offer-tea", capacity: 8, durationMinutes: 120 },
      ],
    });
    // The booking with a thread shows its last message (#106).
    expect(data.conversations).toEqual([{ bookingId: "bk-2031", threadId: "th-3004", text: expect.stringContaining("スーツケース"), at: "2026-10-21T11:05" }]);
    expect((await loadHostBookings(KITCHEN, null)).requested).toBeNull();
    // The studio has no bookings, and the kitchen's are not its own.
    const studio = await loadHostBookings(STUDIO, "bk-2041");
    expect([studio.list, studio.requested]).toEqual([{ status: "ready", bookings: [] }, { status: "missing" }]);
  });

  it("http: nothing to read until the provider API has bookings (#87)", async () => {
    state.config.apiMode = "http";
    const calls = stubNiho(() => new Response("unexpected", { status: 500 }));
    const data = await loadHostBookings(KITCHEN, "bk-2041");
    expect([data.list, data.requested, data.now, data.conversations]).toEqual([{ status: "unavailable" }, { status: "unavailable" }, null, []]);
    expect(calls).toEqual([]);
  });
});

describe("loadHostSession", () => {
  const sofia = { date: "2026-10-27", start: "18:00", experience: "community-dinner", offer: "offer-dinner" };

  it("mock: one session's bookings with the threads they have, at the preview's moment", async () => {
    const data = await loadHostSession(KITCHEN, sofia);
    expect(data.now).toBe("2026-10-21T15:30");
    expect(data.lookup.status === "ready" && data.lookup.session.bookings.map((booking) => booking.guest)).toEqual(["Sofia Rossi"]);
    expect(data.conversations).toEqual([{ bookingId: "bk-2031", threadId: "th-3004", text: expect.stringContaining("スーツケース"), at: "2026-10-21T11:05" }]);
    // Tomorrow's dinner has no thread yet; the studio has no such session.
    expect((await loadHostSession(KITCHEN, { ...sofia, date: "2026-10-22" })).conversations).toEqual([]);
    expect(await loadHostSession(STUDIO, sofia)).toMatchObject({ lookup: { status: "missing" }, conversations: [] });
  });

  it("http: nothing to read until NIHO has the session's guests and attendance (#87)", async () => {
    state.config.apiMode = "http";
    const calls = stubNiho(() => new Response("unexpected", { status: 500 }));
    expect(await loadHostSession(KITCHEN, sofia)).toMatchObject({ lookup: { status: "unavailable" }, conversations: [] });
    expect(calls).toEqual([]);
  });
});

describe("loadHostMessages", () => {
  it("mock: the kitchen's threads, the one ?thread= or ?booking= names, and the experiences' titles", async () => {
    const data = await loadHostMessages(KITCHEN, { thread: "th-3012", booking: null });
    expect([data.today, data.now]).toEqual(["2026-10-21", "2026-10-21T15:30"]);
    expect(data.list.status === "ready" && data.list.threads.map((thread) => thread.id)).toEqual(["th-3012", "th-3007", "th-3004", "th-3010"]);
    expect(data.requested).toMatchObject({ status: "thread", thread: { id: "th-3012" } });
    expect(data.experiences[0]).toEqual({ id: "community-dinner", title: "Kamakura Community Dinner with Locals" });
    // ?thread= wins over ?booking=.
    expect((await loadHostMessages(KITCHEN, { thread: "th-3007", booking: "bk-2031" })).requested).toMatchObject({ status: "thread", thread: { id: "th-3007" } });
    expect((await loadHostMessages(KITCHEN, { thread: null, booking: "bk-2044" })).requested).toMatchObject({ status: "new", thread: { id: "th-bk-2044" } });
    expect((await loadHostMessages(KITCHEN, { thread: null, booking: null })).requested).toBeNull();
    const studio = await loadHostMessages(STUDIO, { thread: "th-3012", booking: null });
    expect([studio.list, studio.requested]).toEqual([{ status: "ready", threads: [] }, { status: "missing" }]);
  });

  it("http: nothing to read until NIHO's API has the messages (#87)", async () => {
    state.config.apiMode = "http";
    const calls = stubNiho(() => new Response("unexpected", { status: 500 }));
    const data = await loadHostMessages(KITCHEN, { thread: "th-3012", booking: null });
    expect([data.list, data.requested]).toEqual([{ status: "unavailable" }, { status: "unavailable" }]);
    expect(calls).toEqual([]);
  });
});

describe("loadHostReviews", () => {
  it("mock: the kitchen's reviews, the preview's moment and the experiences' titles; the studio has none", () => {
    const data = loadHostReviews(KITCHEN);
    expect(data.now).toBe("2026-10-21T15:30");
    expect(data.list.status === "ready" && data.list.reviews.map((review) => review.id)).toEqual(["rv-5020", "rv-5013", "rv-4926", "rv-4912", "rv-4906", "rv-4902"]);
    expect(data.experiences).toEqual([
      { id: "community-dinner", title: "Kamakura Community Dinner with Locals" },
      { id: "kintsugi", title: "Mend a Broken Bowl with a Kamakura Restorer" },
      { id: "coffee", title: "Roast Your Own Coffee in a Kamakura Living Room" },
    ]);
    expect(loadHostReviews(STUDIO).list).toEqual({ status: "ready", reviews: [] });
  });

  it("http: nothing to read until NIHO's API has the reviews (#87)", () => {
    state.config.apiMode = "http";
    const calls = stubNiho(() => new Response("unexpected", { status: 500 }));
    expect(loadHostReviews(KITCHEN).list).toEqual({ status: "unavailable" });
    expect(calls).toEqual([]);
  });
});

describe("hostPageContext", () => {
  it("opens the provider named in ?providerId= and carries it on links", async () => {
    expect(await hostPageContext({ providerId: STUDIO.id })).toMatchObject({ provider: STUDIO, providerNotFound: false, linkProviderId: STUDIO.id });
    expect(await hostPageContext({})).toMatchObject({ provider: KITCHEN, providerNotFound: false, linkProviderId: null });
  });

  it("falls back to the first provider, and says so, for ids this account cannot open", async () => {
    expect(await hostPageContext({ providerId: "someone-else" })).toMatchObject({ provider: KITCHEN, providerNotFound: true, linkProviderId: "someone-else" });
    expect(await hostPageContext({ providerId: "../admin" })).toMatchObject({ provider: KITCHEN, providerNotFound: true, linkProviderId: null });
    expect(await hostPageContext({ providerId: [STUDIO.id, KITCHEN.id] })).toMatchObject({ provider: KITCHEN, providerNotFound: false, linkProviderId: null });
  });

  it("has no provider for an account that has not registered one", async () => {
    state.providers = [];
    expect(await hostPageContext({ providerId: STUDIO.id })).toMatchObject({ provider: null, providers: [] });
  });
});

describe("loadHostSales", () => {
  it("mock: the preview's months for every provider, with the kitchen's ledger; http: nothing to read yet", () => {
    expect(loadHostSales(KITCHEN)).toMatchObject({ status: "ready", period: MOCK_SALES_PERIOD });
    expect(loadHostSales(GARDEN)).toEqual({ status: "ready", period: MOCK_SALES_PERIOD, sales: [] });
    state.config.apiMode = "http";
    expect(loadHostSales(KITCHEN)).toEqual({ status: "unavailable" });
  });
});

describe("loadHostPayout", () => {
  it("mock: the owner reads the kitchen's ready account; an editor reads nothing", async () => {
    expect(await loadHostPayout(KITCHEN)).toEqual({
      load: { status: "owner", payout: { reason: "READY", sharedFrom: null, candidates: [], reuseConsent: REUSE_CONSENT } },
      notice: null,
      redirectTo: null,
    });
    expect(await loadHostPayout(STUDIO)).toEqual({ load: { status: "not-owner" }, notice: null, redirectTo: null });
  });

  it("mock: a provider without an account sees its spots' ready accounts to share", async () => {
    state.scenario = "payments-pending";
    expect((await loadHostPayout(GARDEN)).load).toEqual({ status: "owner", payout: { reason: "NOT_CONNECTED", sharedFrom: null, candidates: [{ id: "sample-spot-house", name: "サンプルの拠点" }], reuseConsent: REUSE_CONSENT } });
    // 売上 only needs the state.
    expect((await loadHostPayout(GARDEN, { candidates: false })).load).toMatchObject({ status: "owner", payout: { reason: "NOT_CONNECTED", candidates: [] } });
  });

  it("mock: back from Stripe (?connect=return) reads the account again first, and says when there is none", async () => {
    expect(await loadHostPayout(KITCHEN, { connect: "return" })).toMatchObject({ load: { payout: { reason: "READY" } }, notice: { tone: "success", message: STRIPE_SYNCED_TEXT }, redirectTo: null });
    state.scenario = "payments-pending";
    expect(await loadHostPayout(GARDEN, { connect: "return" })).toMatchObject({ load: { payout: { reason: "NOT_CONNECTED" } }, notice: { tone: "error", message: HOST_ERROR_REASON_TEXT.PROVIDER_PAYMENT_NOT_CONNECTED } });
    // An expired link (?connect=refresh): the preview has no Stripe page to go back to.
    expect(await loadHostPayout(GARDEN, { connect: "refresh" })).toMatchObject({ load: { payout: { reason: "READY" } }, notice: { tone: "success", message: PREVIEW_STRIPE_TEXT }, redirectTo: null });
  });

  it("http: an expired link (?connect=refresh) goes back to Stripe's page, and only to Stripe's", async () => {
    state.config.apiMode = "http";
    const link = (url: string) => () => Response.json({ url, expiresAt: "2026-10-21T00:05:00.000Z", ready: false, reason: "VERIFICATION_REQUIRED" });
    const calls = stubNiho(link("https://connect.stripe.com/setup/e/acct_sample/abc"));
    expect(await loadHostPayout(KITCHEN, { connect: "refresh" })).toEqual({ load: { status: "error" }, notice: null, redirectTo: "https://connect.stripe.com/setup/e/acct_sample/abc" });
    expect(calls.map((call) => call.url)).toEqual(["https://niho.example.test/api/experience-providers/sample-provider-kitchen/payments/connect/resume"]);
    stubNiho(link("https://stripe.example.test/setup"));
    expect(await loadHostPayout(KITCHEN, { connect: "refresh" })).toMatchObject({ notice: { tone: "error", message: STRIPE_LINK_UNUSABLE_TEXT }, redirectTo: null });
  });
});

describe("loadRegistrationConsent", () => {
  it("reads the provider terms in force from NIHO's provider list", async () => {
    state.scenario = "empty";
    expect(await loadRegistrationConsent()).toEqual({ version: "sample-provider-consent-1", text: "（サンプル）提供者として登録し、NIHO の提供者規約に同意します。この文言は合成データです。" });
    state.config.apiMode = "http";
    stubNiho(() => new Response("unavailable", { status: 503 }));
    expect(await loadRegistrationConsent()).toBeNull();
  });
});
