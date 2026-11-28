import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  accounts: ["acct_Synthetic123"] as string[],
  provider: { id: "provider_synthetic", nihoUserId: "user_synthetic", memberRole: "OWNER" as string | null },
  listPayoutAccountsForHost: vi.fn(async () => state.accounts),
  payout: null as null | { account: { stripeAccountRef: string | null; purpose: string } },
  connectOn: true,
  currentPayout: vi.fn(async () => state.payout),
  direct: false,
  sellerIsDirect: vi.fn(async () => state.direct),
  createLoginLink: vi.fn(async (input?: unknown) => {
    void input;
    return "https://stripe.com/express/synthetic-one-time-link";
  }),
}));

vi.mock("@/lib/experience/store-server", () => ({
  hostSalesRepository: () => ({ listPayoutAccountsForHost: state.listPayoutAccountsForHost }),
  connectAccounts: () => (state.connectOn ? { currentPayout: state.currentPayout } : null),
  sellerIsDirect: (...args: unknown[]) => state.sellerIsDirect(...(args as [])),
}));
vi.mock("@/lib/host/server", () => ({
  readHostSession: async () => ({ accessToken: "synthetic" }),
  loadHostProviders: async () => ({ status: "ok", providers: [state.provider] }),
}));
vi.mock("@/lib/host/session", () => ({ accessTokenUsable: () => true }));
vi.mock("@niho-experience/experience-payments", () => ({
  createConnectedAccountLoginLink: (...args: unknown[]) => state.createLoginLink(...args as [never]),
}));

import { hostStripeLoginUrl } from "./stripe-login-server";

describe("hostStripeLoginUrl", () => {
  beforeEach(() => {
    state.accounts = ["acct_Synthetic123"];
    state.provider = { id: "provider_synthetic", nihoUserId: "user_synthetic", memberRole: "OWNER" };
    state.payout = null;
    state.direct = false;
    state.connectOn = true;
    state.sellerIsDirect.mockClear();
    state.currentPayout.mockClear();
    state.listPayoutAccountsForHost.mockClear();
    state.createLoginLink.mockClear();
    vi.stubEnv("EXPERIENCE_STRIPE_PLATFORM_SECRET_KEY", "sk_test_synthetic");
  });

  it("creates a login link only for the selected provider's single account", async () => {
    await expect(hostStripeLoginUrl("provider_synthetic")).resolves.toBe("https://stripe.com/express/synthetic-one-time-link");
    expect(state.listPayoutAccountsForHost).toHaveBeenCalledWith({ providerId: "provider_synthetic", nihoUserId: "user_synthetic", calendarRoleCeiling: "OWNER" });
    expect(state.createLoginLink).toHaveBeenCalledWith({ accountId: "acct_Synthetic123", platformStripeKey: "sk_test_synthetic" });
  });

  it("does not choose when NIHO does not confirm OWNER or the provider has multiple accounts", async () => {
    state.provider = { ...state.provider, memberRole: "EDITOR" };
    await expect(hostStripeLoginUrl("provider_synthetic")).resolves.toBeNull();
    expect(state.listPayoutAccountsForHost).not.toHaveBeenCalled();

    state.provider = { ...state.provider, memberRole: "OWNER" };
    state.accounts = ["acct_Synthetic123", "acct_Synthetic456"];
    await expect(hostStripeLoginUrl("provider_synthetic")).resolves.toBeNull();
    expect(state.createLoginLink).not.toHaveBeenCalled();
  });

  it("opens the payout account the host registered itself (chosen by the server) only when it has no Direct charge seller", async () => {
    state.accounts = [];
    state.payout = { account: { stripeAccountRef: "acct_Payout123456", purpose: "PAYOUT" } };
    await expect(hostStripeLoginUrl("provider_synthetic")).resolves.toBe("https://stripe.com/express/synthetic-one-time-link");
    expect(state.currentPayout).toHaveBeenCalledWith("provider_synthetic");
    expect(state.createLoginLink).toHaveBeenCalledWith({ accountId: "acct_Payout123456", platformStripeKey: "sk_test_synthetic" });

    // The Direct charge seller's account wins when there is one; several accounts still choose nothing.
    state.createLoginLink.mockClear();
    state.accounts = ["acct_Synthetic123"];
    await hostStripeLoginUrl("provider_synthetic");
    expect(state.createLoginLink).toHaveBeenCalledWith({ accountId: "acct_Synthetic123", platformStripeKey: "sk_test_synthetic" });
  });

  it("opens nothing for a payout account still being created, or while the onboarding flag is off", async () => {
    state.accounts = [];
    state.payout = { account: { stripeAccountRef: null, purpose: "PAYOUT" } };
    await expect(hostStripeLoginUrl("provider_synthetic")).resolves.toBeNull();
    state.payout = { account: { stripeAccountRef: "acct_Payout123456", purpose: "PAYOUT" } };
    state.connectOn = false;
    await expect(hostStripeLoginUrl("provider_synthetic")).resolves.toBeNull();
    expect(state.createLoginLink).not.toHaveBeenCalled();
  });

  it("opens Stripe's dashboard, without an API call, for a seller bound to its own Stripe account (also with both flags off)", async () => {
    state.direct = true;
    state.connectOn = false;
    await expect(hostStripeLoginUrl("provider_synthetic")).resolves.toBe("https://dashboard.stripe.com/");
    await expect(hostStripeLoginUrl("provider_synthetic", "direct")).resolves.toBe("https://dashboard.stripe.com/");
    expect(state.sellerIsDirect).toHaveBeenCalledWith("provider_synthetic");
    expect(state.listPayoutAccountsForHost).not.toHaveBeenCalled();
    expect(state.createLoginLink).not.toHaveBeenCalled();
    // Without the key too: it is a public page.
    vi.stubEnv("EXPERIENCE_STRIPE_PLATFORM_SECRET_KEY", "");
    await expect(hostStripeLoginUrl("provider_synthetic")).resolves.toBe("https://dashboard.stripe.com/");
  });

  it("opens the Express payout account from the Express block, even for a seller with its own account", async () => {
    state.direct = true;
    state.payout = { account: { stripeAccountRef: "acct_Payout123456", purpose: "PAYOUT" } };
    await expect(hostStripeLoginUrl("provider_synthetic", "payout")).resolves.toBe("https://stripe.com/express/synthetic-one-time-link");
    expect(state.createLoginLink).toHaveBeenCalledWith({ accountId: "acct_Payout123456", platformStripeKey: "sk_test_synthetic" });
    expect(state.listPayoutAccountsForHost).not.toHaveBeenCalled();
  });

  it("opens nothing for the own-account button when the seller is not bound to one, and nothing for a non-OWNER", async () => {
    await expect(hostStripeLoginUrl("provider_synthetic", "direct")).resolves.toBeNull();
    state.direct = true;
    state.sellerIsDirect.mockClear();
    state.provider = { ...state.provider, memberRole: "EDITOR" };
    await expect(hostStripeLoginUrl("provider_synthetic")).resolves.toBeNull();
    expect(state.sellerIsDirect).not.toHaveBeenCalled();
  });
});
