import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StoreAccessDeniedError, StoreError } from "@niho-experience/experience-store";

/** この口座への入金 against a stubbed store and Stripe read (#91): when it is read, how, and what a failure shows. */
const state = vi.hoisted(() => ({
  mock: false,
  enabled: true,
  store: null as null | { listPayoutAccountsForHost: ReturnType<typeof vi.fn> },
  stripe: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({
  config: {
    get hostSalesPayoutsEnabled() {
      return state.enabled;
    },
  },
}));
vi.mock("@/lib/experience/store-server", () => ({ hostSalesRepository: () => state.store }));
vi.mock("@/lib/host/server", () => ({ isHostMock: () => state.mock }));
vi.mock("./site-bookings-server", () => ({ ownerActor: (providerId: string, nihoUserId: string) => ({ providerId, nihoUserId, calendarRoleCeiling: "OWNER" }) }));
vi.mock("@niho-experience/experience-payments", () => ({ readConnectedPayouts: (...args: unknown[]) => state.stripe(...args) }));

import { loadSitePayouts, SITE_PAYOUTS_DEADLINE_MS } from "./site-sales-payouts-server";
import { SITE_PAYOUTS_FAILED_TEXT, SITE_PAYOUTS_SLOW_TEXT, SITE_PAYOUTS_UNREACHABLE_TEXT } from "./site-sales-payouts";

const OWNER = { id: "sample-provider", memberRole: "OWNER" } as const;
const SESSION = { nihoUserId: "sample-niho-user" };
const ACTOR = { providerId: "sample-provider", nihoUserId: "sample-niho-user", calendarRoleCeiling: "OWNER" };
const ACCOUNT = "acct_SampleSeller0001";
const OTHER = "acct_SampleSeller0002";
const NOVEMBER = { year: 2026, month: 11 };
const OCTOBER = { year: 2026, month: 10 };
/** 2026-11-01T00:00+09:00 and 2026-12-01T00:00+09:00. */
const NOVEMBER_FROM = Date.parse("2026-10-31T15:00:00.000Z") / 1000;
const OCTOBER_FROM = Date.parse("2026-09-30T15:00:00.000Z") / 1000;
const read = (amount: number, arrival: string) => ({
  kind: "read",
  balance: [{ currency: "JPY", available: 1_000, pending: 2_000 }],
  payouts: [{ key: `${String(amount).padStart(16, "0")}`, amount, currency: "JPY", arrivalDateUtc: arrival, status: "PAID" }],
  more: false,
});

beforeEach(() => {
  vi.useFakeTimers({ now: new Date("2026-11-20T03:00:00.000Z"), toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.stubEnv("EXPERIENCE_STRIPE_PLATFORM_SECRET_KEY", "sk_test_synthetic");
  state.mock = false;
  state.enabled = true;
  state.store = { listPayoutAccountsForHost: vi.fn(async () => [ACCOUNT]) };
  state.stripe = vi.fn(async () => read(40_500, "2026-11-05T00:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("この口座への入金 from Stripe", () => {
  it("reads this month's payouts from last month's first day with no end, and the balance, with the platform key, after the store's OWNER check", async () => {
    const load = await loadSitePayouts(OWNER, SESSION, NOVEMBER);
    expect(state.store!.listPayoutAccountsForHost).toHaveBeenCalledWith(ACTOR);
    expect(state.stripe).toHaveBeenCalledWith({ accountId: ACCOUNT, arrivalFrom: OCTOBER_FROM, arrivalBefore: null, platformStripeKey: "sk_test_synthetic", timeoutMs: 3_500 });
    expect(load).toMatchObject({ status: "live", panel: { figures: [{ label: "入金予定", value: "¥3,000" }, { label: "入金済み", value: "¥40,500" }] } });
    // Nothing of the account reaches the page.
    expect(JSON.stringify(load)).not.toContain("acct_");
  });

  it("on 11/1, counts in 入金予定 a payout due 10/31 that is still in transit; once paid, it is October's", async () => {
    vi.setSystemTime(new Date("2026-11-01T03:00:00.000Z"));
    const due1031 = (status: string) => ({
      kind: "read",
      balance: [{ currency: "JPY", available: 1_000, pending: 2_000 }],
      payouts: [
        { key: "c000000000000001", amount: 12_000, currency: "JPY", arrivalDateUtc: "2026-10-31T00:00:00.000Z", status },
        { key: "c000000000000002", amount: 9_000, currency: "JPY", arrivalDateUtc: "2026-10-20T00:00:00.000Z", status: "PAID" },
      ],
      more: false,
    });
    state.stripe.mockResolvedValueOnce(due1031("IN_TRANSIT"));
    const inTransit = await loadSitePayouts(OWNER, SESSION, NOVEMBER);
    expect(state.stripe).toHaveBeenLastCalledWith(expect.objectContaining({ arrivalFrom: OCTOBER_FROM, arrivalBefore: null }));
    expect(inTransit).toMatchObject({ status: "live", panel: { figures: [{ label: "入金予定", value: "¥15,000" }, { label: "入金済み", value: "¥0" }] } });
    expect(inTransit.status === "live" && inTransit.panel.rows.map((row) => [row.date, row.status.label])).toEqual([["2026-10-31", "送金中"]]);

    state.stripe.mockResolvedValueOnce(due1031("PAID"));
    const paid = await loadSitePayouts(OWNER, SESSION, NOVEMBER);
    expect(paid).toMatchObject({ status: "live", panel: { figures: [{ label: "入金予定", value: "¥3,000" }, { label: "入金済み", value: "¥0" }], rows: [] } });

    state.stripe.mockResolvedValueOnce(due1031("PAID"));
    const october = await loadSitePayouts(OWNER, SESSION, OCTOBER);
    expect(state.stripe).toHaveBeenLastCalledWith(expect.objectContaining({ arrivalFrom: OCTOBER_FROM, arrivalBefore: NOVEMBER_FROM }));
    expect(october).toMatchObject({ status: "live", panel: { figures: [{ label: "入金済み", value: "¥21,000" }] } });
  });

  it("reads an earlier month within it, and sums the provider's accounts", async () => {
    state.store!.listPayoutAccountsForHost.mockResolvedValueOnce([ACCOUNT, OTHER]);
    state.stripe.mockImplementation(async ({ accountId }: { accountId: string }) => (accountId === ACCOUNT ? read(1_000, "2026-10-09T00:00:00.000Z") : read(2_000, "2026-10-20T00:00:00.000Z")));
    const load = await loadSitePayouts(OWNER, SESSION, OCTOBER);
    expect(state.stripe.mock.calls.map(([input]) => [input.accountId, input.arrivalFrom, input.arrivalBefore])).toEqual([[ACCOUNT, OCTOBER_FROM, NOVEMBER_FROM], [OTHER, OCTOBER_FROM, NOVEMBER_FROM]]);
    expect(load).toMatchObject({ status: "live", panel: { figures: [{ label: "入金済み", value: "¥3,000" }], notes: ["Stripe の口座が 2 つあり、その合計です。"] } });
    expect(load.status === "live" && load.panel.rows.map((row) => row.date)).toEqual(["2026-10-20", "2026-10-09"]);
  });

  it("is not there for anyone but the OWNER, with the flag off, without the key, the store, an account, or when the store refuses", async () => {
    expect(await loadSitePayouts({ id: "sample-provider", memberRole: "EDITOR" }, SESSION, NOVEMBER)).toEqual({ status: "closed" });
    state.enabled = false;
    expect(await loadSitePayouts(OWNER, SESSION, NOVEMBER)).toEqual({ status: "closed" });
    state.enabled = true;
    vi.stubEnv("EXPERIENCE_STRIPE_PLATFORM_SECRET_KEY", "");
    expect(await loadSitePayouts(OWNER, SESSION, NOVEMBER)).toEqual({ status: "closed" });
    vi.stubEnv("EXPERIENCE_STRIPE_PLATFORM_SECRET_KEY", "sk_test_synthetic");
    state.store!.listPayoutAccountsForHost.mockResolvedValueOnce([]);
    expect(await loadSitePayouts(OWNER, SESSION, NOVEMBER)).toEqual({ status: "closed" });
    state.store!.listPayoutAccountsForHost.mockRejectedValueOnce(new StoreAccessDeniedError());
    expect(await loadSitePayouts(OWNER, SESSION, NOVEMBER)).toEqual({ status: "closed" });
    state.store = null;
    expect(await loadSitePayouts(OWNER, SESSION, NOVEMBER)).toEqual({ status: "closed" });
    expect(state.stripe).not.toHaveBeenCalled();
  });

  it("says what went wrong without logging more than the error's class", async () => {
    state.stripe.mockResolvedValueOnce({ kind: "unreachable" });
    expect(await loadSitePayouts(OWNER, SESSION, NOVEMBER)).toEqual({ status: "error", text: SITE_PAYOUTS_UNREACHABLE_TEXT });
    expect(console.error).toHaveBeenLastCalledWith("Experience host payouts read failed", { error: "unreachable" });
    state.stripe.mockRejectedValueOnce(Object.assign(new Error("connection to api.stripe.com failed for acct_SampleSeller0001"), { type: "StripeConnectionError", raw: { message: "raw" } }));
    expect(await loadSitePayouts(OWNER, SESSION, NOVEMBER)).toEqual({ status: "error", text: SITE_PAYOUTS_FAILED_TEXT });
    expect(console.error).toHaveBeenLastCalledWith("Experience host payouts read failed", { error: "StripeConnectionError" });
    state.store!.listPayoutAccountsForHost.mockRejectedValueOnce(new StoreError("The provider has more Stripe accounts than one read takes."));
    expect(await loadSitePayouts(OWNER, SESSION, NOVEMBER)).toEqual({ status: "error", text: SITE_PAYOUTS_FAILED_TEXT });
    expect(console.error).toHaveBeenLastCalledWith("Experience host payouts read failed", { error: "StoreError" });
    for (const [message] of vi.mocked(console.error).mock.calls.map(([, detail]) => [JSON.stringify(detail)])) expect(message).not.toMatch(/acct_|raw|api\.stripe/);
  });

  it("gives up on a slow Stripe after the deadline, saying so", async () => {
    state.stripe.mockImplementationOnce(() => new Promise(() => undefined));
    const load = loadSitePayouts(OWNER, SESSION, NOVEMBER);
    await vi.advanceTimersByTimeAsync(SITE_PAYOUTS_DEADLINE_MS);
    expect(await load).toEqual({ status: "error", text: SITE_PAYOUTS_SLOW_TEXT });
    expect(console.error).toHaveBeenLastCalledWith("Experience host payouts read failed", { error: "SlowStripeError" });
  });
});

describe("the preview", () => {
  it("shows synthetic payouts only to the `?mock=site-sales` sign-in, never reading the store or Stripe", async () => {
    state.mock = true;
    expect(await loadSitePayouts(OWNER, SESSION, OCTOBER)).toEqual({ status: "closed" });
    const october = await loadSitePayouts(OWNER, { ...SESSION, mockScenario: "site-sales" }, OCTOBER);
    expect(october).toMatchObject({ status: "live", panel: { figures: [{ label: "入金予定", value: "¥80,500" }, { label: "入金済み", value: "¥52,300" }] } });
    const september = await loadSitePayouts(OWNER, { ...SESSION, mockScenario: "site-sales" }, { year: 2026, month: 9 });
    expect(september).toMatchObject({ status: "live", panel: { figures: [{ label: "入金済み", value: "¥58,400" }] } });
    expect(september.status === "live" && september.panel.rows.map((row) => row.shortDate)).toEqual(["09/25", "09/11"]);
    expect(state.store!.listPayoutAccountsForHost).not.toHaveBeenCalled();
    expect(state.stripe).not.toHaveBeenCalled();
  });
});
