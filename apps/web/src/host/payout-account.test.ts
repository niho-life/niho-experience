import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: { experiencePayoutAccountConsentVersion: "payout-v1" } }));
vi.mock("@/lib/experience/store-server", () => ({ experiencePublicationRepository: () => null, payoutAccountConsents: () => null }));

import type { HostPayoutAccountRead } from "@/lib/experience/host-payout-account";
import {
  experiencePayoutLines,
  experiencePayoutStatus,
  hostPayoutLoadOf,
  PAYOUT_ACCOUNT_PROBLEM_TEXT,
  payoutAccountConsentText,
  payoutConsentOutcomeOrNull,
  type ExperiencePayoutLoad,
} from "./payout-account";
import { experiencePayoutLoadOf } from "./payout-account-server";

/** 設定 › 受取口座 with Experience host accounts (ADR 0003 slice 3): wording and mapping, synthetic data only. */
const HOST = `hst_${"a".repeat(32)}`;
const profile = {
  providerId: "provider-supper", legacyProviderId: null, providerDisplayName: "Synthetic Supper Club",
  sellerNihoAccountRef: `sel_${"b".repeat(32)}`, stripeConnectAccountRef: "acct_SyntheticHostSeller01", sellerDisplayName: "Synthetic Legal Seller KK",
};
const summary = { idLast4: "er01", country: "JP", defaultCurrency: "jpy", chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true };
const consent = { stripeConnectAccountRef: profile.stripeConnectAccountRef, consentVersion: "payout-v1", consentedAtUtc: "2026-11-07T01:00:00.000Z", consentedByHostAccountId: HOST };
const read = (overrides: Partial<Extract<HostPayoutAccountRead, { kind: "read" }>> = {}): HostPayoutAccountRead => ({
  kind: "read", actor: { providerId: profile.providerId, nihoUserId: HOST }, profile, hostAccountActive: true,
  stripe: { kind: "ready", account: summary }, consent, ...overrides,
});
type Owner = Extract<ExperiencePayoutLoad, { status: "owner" }>;

describe("受取口座 from Stripe and the OWNER's consent", () => {
  it("shows the account's last 4 characters, Stripe's state and whether the consent counts at the current version", () => {
    const ready = experiencePayoutLoadOf(read(), profile.providerId, "payout-v1");
    expect(ready).toEqual({
      status: "owner", providerName: "Synthetic Supper Club", accountLast4: "er01", consentVersion: "payout-v1",
      stripe: "ready", problems: [], consent: { state: "current", consentedAtUtc: "2026-11-07T01:00:00.000Z" },
    });
    expect(experiencePayoutStatus(ready)).toEqual({ label: "準備済み", tone: "ok" });
    expect(hostPayoutLoadOf(ready)).toEqual({ status: "owner", payout: { reason: "READY", sharedFrom: null, candidates: [], reuseConsent: null } });
    // Another version is outdated; none is none; both ask for the consent.
    const outdated = experiencePayoutLoadOf(read(), profile.providerId, "payout-v2") as Owner;
    expect(outdated.consent).toEqual({ state: "outdated" });
    expect(experiencePayoutStatus(outdated)).toEqual({ label: "同意が必要", tone: "wait" });
    expect((experiencePayoutLoadOf(read({ consent: null }), profile.providerId, "payout-v1") as Owner).consent).toEqual({ state: "none" });
    // The page's provider must be the account's own.
    expect(experiencePayoutLoadOf(read(), "provider-other", "payout-v1")).toEqual({ status: "error" });
  });

  it("says Stripe's problems in plain words and maps them to the console's readiness reasons", () => {
    const notReady = experiencePayoutLoadOf(read({ stripe: { kind: "not_ready", account: summary, problems: ["NOT_JPY", "DETAILS_NOT_SUBMITTED", "PAYOUTS_DISABLED"] } }), profile.providerId, "payout-v1") as Owner;
    expect(experiencePayoutLines(notReady)).toEqual([
      PAYOUT_ACCOUNT_PROBLEM_TEXT.DETAILS_NOT_SUBMITTED, PAYOUT_ACCOUNT_PROBLEM_TEXT.PAYOUTS_DISABLED, PAYOUT_ACCOUNT_PROBLEM_TEXT.NOT_JPY,
    ]);
    expect(experiencePayoutStatus(notReady)).toEqual({ label: "確認が必要", tone: "wait" });
    expect(hostPayoutLoadOf(notReady)).toMatchObject({ payout: { reason: "VERIFICATION_REQUIRED" } });
    const reason = (problems: Owner["problems"]) => hostPayoutLoadOf({ ...notReady, problems });
    expect(reason(["CHARGES_DISABLED"])).toMatchObject({ payout: { reason: "CHARGES_DISABLED" } });
    expect(reason(["PAYOUTS_DISABLED"])).toMatchObject({ payout: { reason: "PAYOUTS_DISABLED" } });
    expect(reason(["NOT_JAPAN"])).toMatchObject({ payout: { reason: "RESTRICTED" } });
    const unreachable = experiencePayoutLoadOf(read({ stripe: { kind: "unreachable" } }), profile.providerId, "payout-v1") as Owner;
    expect(experiencePayoutLines(unreachable)[0]).toContain("Stripe でこの口座を確認できません");
    expect(hostPayoutLoadOf(unreachable)).toMatchObject({ payout: { reason: "RESTRICTED" } });
    // Stripe not answering now: shown as unknown, never as ready.
    const unknown = experiencePayoutLoadOf({ kind: "stripe-unavailable", actor: { providerId: profile.providerId, nihoUserId: HOST }, profile, hostAccountActive: true }, profile.providerId, "payout-v1") as Owner;
    expect(unknown).toMatchObject({ stripe: "unknown", consent: { state: "unknown" } });
    expect(hostPayoutLoadOf(unknown)).toEqual({ status: "error" });
  });

  it("tells setup and errors apart", () => {
    expect(experiencePayoutLoadOf({ kind: "setup-required", providerId: profile.providerId }, profile.providerId, "payout-v1")).toEqual({ status: "setup-required" });
    expect(experiencePayoutLoadOf({ kind: "setup-required", providerId: "provider-other" }, profile.providerId, "payout-v1")).toEqual({ status: "error" });
    for (const kind of ["none", "ambiguous", "unavailable"] as const) expect(experiencePayoutLoadOf({ kind }, profile.providerId, "payout-v1")).toEqual({ status: "error" });
    expect(experiencePayoutStatus({ status: "setup-required" })).toEqual({ label: "未登録", tone: "wait" });
    expect(hostPayoutLoadOf({ status: "setup-required" })).toMatchObject({ payout: { reason: "NOT_CONNECTED" } });
    expect(hostPayoutLoadOf({ status: "not-owner" })).toEqual({ status: "not-owner" });
  });

  it("words the consent with the provider and the account's last 4 characters, and reads only known outcomes", () => {
    const text = payoutAccountConsentText({ providerName: "Synthetic Supper Club", accountLast4: "er01" });
    expect(text).toContain("Synthetic Supper Club");
    expect(text).toContain("末尾 er01");
    expect(text).toContain("Stripe の決済手数料と NIHO の手数料");
    expect(text).toContain("取り消すと");
    expect(text).not.toContain("acct_");
    expect(payoutConsentOutcomeOrNull("consented")).toBe("consented");
    expect(payoutConsentOutcomeOrNull("toString")).toBeNull();
    expect(payoutConsentOutcomeOrNull(["consented"])).toBeNull();
  });
});
