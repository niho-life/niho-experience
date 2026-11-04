import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  accounts: ["acct_Synthetic123"] as string[],
  provider: { id: "provider_synthetic", nihoUserId: "user_synthetic", memberRole: "OWNER" as string | null },
  listPayoutAccountsForHost: vi.fn(async () => state.accounts),
  createLoginLink: vi.fn(async (input?: unknown) => {
    void input;
    return "https://stripe.com/express/synthetic-one-time-link";
  }),
}));

vi.mock("@/lib/experience/store-server", () => ({
  hostSalesRepository: () => ({ listPayoutAccountsForHost: state.listPayoutAccountsForHost }),
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
});
