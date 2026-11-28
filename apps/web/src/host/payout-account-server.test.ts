import { beforeEach, describe, expect, it, vi } from "vitest";

/* loadExperiencePayout for a host registering its own account (#710): 設定 reads Stripe, 売上 and ホーム do not. */
const state = vi.hoisted(() => ({
  config: { hostConnectOnboardingEnabled: true, hostStandardOnboardingEnabled: false, experiencePayoutAccountConsentVersion: "v1" },
  load: vi.fn(async (): Promise<{ state: string } | "seller"> => ({ state: "READY" as const })),
  loadDirect: vi.fn(async () => ({ state: "NOT_STARTED" as string, accountRef: null as string | null })),
  sellerExists: vi.fn(async () => false),
  own: null as null | { account: { purpose: string; providerId: string; retiredAtUtc: string | null } },
  expressRow: false,
  history: false,
  disclosure: null as null | { method: string },
  readKind: "setup-required" as string,
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ get config() { return state.config; } }));
vi.mock("@/lib/experience/host-payout-account", () => ({
  readHostPayoutAccount: async () => state.readKind === "setup-required"
    ? { kind: "setup-required", providerId: "provider-a" }
    : { kind: "read", profile: { providerId: "provider-a", providerDisplayName: "主催者", stripeConnectAccountRef: "acct_SyntheticOwn0001" }, consent: null, stripe: { kind: "ready" } },
  payoutConsentCurrent: () => false,
}));
vi.mock("@/lib/experience/host-direct-account", () => ({ loadDirectScreenState: (...args: unknown[]) => state.loadDirect(...(args as [])) }));
vi.mock("@/lib/experience/store-server", () => ({
  providerSellerDisclosureRepository: () => ({ getForOwner: async () => ({ disclosure: state.disclosure }) }),
}));
vi.mock("@/lib/experience/host-connect-onboarding", () => ({ loadPayoutScreenState: (...args: unknown[]) => state.load(...(args as [])) }));
vi.mock("@/lib/experience/host-connect-onboarding-server", () => ({ payoutOnboardingDeps: () => ({
  fake: true,
  accounts: {
    sellerExists: () => state.sellerExists(),
    findByAccountRef: async () => state.own,
    payoutBlock: async () => (state.expressRow ? { current: { account: {} } } : state.history ? { current: null } : null),
  },
}) }));

import { loadExperiencePayout } from "./payout-account-server";

const session = { hostAccountId: `hst_${"a".repeat(32)}` };
const provider = { id: "provider-a", memberRole: "OWNER" as const };

beforeEach(() => {
  state.load.mockClear().mockResolvedValue({ state: "READY" });
  state.loadDirect.mockClear().mockResolvedValue({ state: "NOT_STARTED", accountRef: null });
  state.sellerExists.mockClear().mockResolvedValue(false);
  state.config.hostConnectOnboardingEnabled = true;
  state.config.hostStandardOnboardingEnabled = false;
  state.own = null; state.expressRow = false; state.history = false; state.disclosure = null; state.readKind = "setup-required";
});

describe("loadExperiencePayout without a Direct charge seller", () => {
  it("reads Stripe for 設定 › 受取口座", async () => {
    expect(await loadExperiencePayout(session, provider)).toEqual({ status: "connect", payout: "READY", direct: null });
    expect(state.load).toHaveBeenCalledTimes(1);
  });

  it("does not read Stripe or keep anything for the pages that only need 'not connected'", async () => {
    expect(await loadExperiencePayout(session, provider, { readConnect: false })).toEqual({ status: "connect", payout: "NOT_STARTED", direct: null });
    expect(state.load).not.toHaveBeenCalled();
  });

  it("keeps the old 'setup required' while the flag is off", async () => {
    state.config.hostConnectOnboardingEnabled = false;
    expect(await loadExperiencePayout(session, provider)).toEqual({ status: "setup-required" });
  });
});

describe("loadExperiencePayout with the host's own Stripe account (3c-1)", () => {
  it("shows the direct block alone when only the standard flag is on", async () => {
    state.config.hostConnectOnboardingEnabled = false;
    state.config.hostStandardOnboardingEnabled = true;
    expect(await loadExperiencePayout(session, provider)).toEqual({
      status: "connect", payout: null, direct: { state: "NOT_STARTED", providerName: "", accountLast4: null, consentVersion: "v1", disclosure: "missing" },
    });
    expect(state.load).not.toHaveBeenCalled();
    state.sellerExists.mockResolvedValue(true);
    expect(await loadExperiencePayout(session, provider)).toEqual({ status: "setup-required" });
    expect(await loadExperiencePayout(session, provider, { readConnect: false })).toMatchObject({ status: "connect", payout: null, direct: { state: "NOT_STARTED" } });
  });

  it("shows both blocks, and the account and the disclosure at READY", async () => {
    state.config.hostStandardOnboardingEnabled = true;
    state.loadDirect.mockResolvedValue({ state: "READY", accountRef: "acct_SyntheticOwn0001" });
    expect(await loadExperiencePayout(session, { ...provider, displayName: "主催者" })).toEqual({
      status: "connect", payout: "READY", direct: { state: "READY", providerName: "主催者", accountLast4: "0001", consentVersion: "v1", disclosure: "missing" },
    });
    state.disclosure = { method: "NATIVE" };
    expect(await loadExperiencePayout(session, provider)).toMatchObject({ direct: { disclosure: "ready" } });
    state.load.mockResolvedValue("seller");
    expect(await loadExperiencePayout(session, provider)).toEqual({ status: "setup-required" });
  });

  it("marks a seller whose account is its own, and shows the Express block while there is a row or a history of agent sales", async () => {
    state.readKind = "read";
    state.config.hostStandardOnboardingEnabled = true;
    expect(await loadExperiencePayout(session, provider)).toMatchObject({ status: "owner" });
    expect(await loadExperiencePayout(session, provider)).not.toHaveProperty("standard");
    state.own = { account: { purpose: "DIRECT", providerId: "provider-a", retiredAtUtc: null } };
    state.history = true;
    expect(await loadExperiencePayout(session, provider)).toMatchObject({ status: "owner", standard: true, payout: "NOT_STARTED" });
    state.expressRow = true;
    state.load.mockResolvedValue({ state: "VERIFYING" });
    expect(await loadExperiencePayout(session, provider)).toMatchObject({ standard: true, payout: "VERIFYING" });
    state.own = { account: { purpose: "DIRECT", providerId: "provider-a", retiredAtUtc: "2026-11-28T00:00:00.000Z" } };
    expect(await loadExperiencePayout(session, provider)).not.toHaveProperty("standard");
    // The pages that only need the status read nothing more.
    state.load.mockClear();
    expect(await loadExperiencePayout(session, provider, { readConnect: false })).not.toHaveProperty("payout");
    expect(state.load).not.toHaveBeenCalled();
  });
});
