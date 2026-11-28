import { beforeEach, describe, expect, it, vi } from "vitest";

/* loadExperiencePayout for a host registering its own account (#710): 設定 reads Stripe, 売上 and ホーム do not. */
const state = vi.hoisted(() => ({
  config: { hostConnectOnboardingEnabled: true, experiencePayoutAccountConsentVersion: "v1" },
  load: vi.fn(async () => ({ state: "READY" as const })),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ get config() { return state.config; } }));
vi.mock("@/lib/experience/host-payout-account", () => ({
  readHostPayoutAccount: async () => ({ kind: "setup-required", providerId: "provider-a" }),
  payoutConsentCurrent: () => false,
}));
vi.mock("@/lib/experience/host-connect-onboarding", () => ({ loadPayoutScreenState: (...args: unknown[]) => state.load(...(args as [])) }));
vi.mock("@/lib/experience/host-connect-onboarding-server", () => ({ payoutOnboardingDeps: () => ({ fake: true }) }));

import { loadExperiencePayout } from "./payout-account-server";

const session = { hostAccountId: `hst_${"a".repeat(32)}` };
const provider = { id: "provider-a", memberRole: "OWNER" as const };

beforeEach(() => { state.load.mockClear(); state.config.hostConnectOnboardingEnabled = true; });

describe("loadExperiencePayout without a Direct charge seller", () => {
  it("reads Stripe for 設定 › 受取口座", async () => {
    expect(await loadExperiencePayout(session, provider)).toEqual({ status: "connect", state: "READY" });
    expect(state.load).toHaveBeenCalledTimes(1);
  });

  it("does not read Stripe or keep anything for the pages that only need 'not connected'", async () => {
    expect(await loadExperiencePayout(session, provider, { readConnect: false })).toEqual({ status: "connect", state: "NOT_STARTED" });
    expect(state.load).not.toHaveBeenCalled();
  });

  it("keeps the old 'setup required' while the flag is off", async () => {
    state.config.hostConnectOnboardingEnabled = false;
    expect(await loadExperiencePayout(session, provider)).toEqual({ status: "setup-required" });
  });
});
