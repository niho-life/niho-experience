import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { CONNECT_PAYOUT_STATES, DIRECT_PAYOUT_STATES, experiencePayoutStatus, hostPayoutLoadOf, PAYOUT_CONSENT_OUTCOMES, payoutConsentOutcomeOrNull, type ConnectPayoutState, type DirectPayoutSection, type ExperiencePayoutLoad } from "@/host/payout-account";
import { HostPayoutAccountPanel } from "./HostPayoutAccountPanel";

/* 設定 › 受取口座 for a host that registers its own account (#710): the six states, their words and their one button. */
const render = (state: ConnectPayoutState) => renderToStaticMarkup(
  createElement(HostPayoutAccountPanel, { providerId: "provider-a", load: { status: "connect", payout: state, direct: null }, notice: null }),
).replace(/<!-- -->/g, "");
const ONBOARD = 'action="/host/api/payout-account/onboarding?providerId=provider-a"';

describe("受取口座 of a host registering its own account", () => {
  it.each([
    ["NOT_STARTED", "受取口座を登録する", "未登録"],
    ["IN_PROGRESS", "Stripe で続きを入力する", "入力の途中"],
    ["ACTION_REQUIRED", "Stripe で入力する", "追加の情報が必要"],
  ] as const)("%s offers the onboarding button %s", (state, button, pill) => {
    const html = render(state);
    expect(html).toContain(button);
    expect(html).toContain(pill);
    expect(html).toContain(ONBOARD);
    expect(html).toContain('method="post"');
    expect(html).not.toContain("/host/api/stripe-login");
  });

  it("says Stripe is checking, with no button", () => {
    const html = render("VERIFYING");
    expect(html).toContain("Stripe で確認中です");
    expect(html).not.toContain("<button");
  });

  it("says a stopped account cannot be used and to ask the office, with no button", () => {
    const html = render("REJECTED");
    expect(html).toContain("この口座は使えません。事務局にお問い合わせください");
    expect(html).not.toContain("<button");
  });

  it("says sales can be received (3b-2), opens Stripe's dashboard, and never shows the bank account", () => {
    const html = render("READY");
    expect(html).toContain("売上を受け取れます");
    expect(html).toContain("Stripe で見る");
    expect(html).toContain('action="/host/api/stripe-login"');
    expect(html).not.toContain(ONBOARD);
    expect(html).not.toMatch(/末尾|acct_/);
  });

  it("asks to read the page again when Stripe could not be read and nothing was kept", () => {
    const html = render("unknown");
    expect(html).toContain("読み込めませんでした");
    expect(html).not.toContain("<button");
  });

  it("is read by the other panels as not connected, as a host without a seller always was", () => {
    expect(hostPayoutLoadOf({ status: "connect", payout: "READY", direct: null })).toMatchObject({ status: "owner", payout: { reason: "NOT_CONNECTED" } });
    expect(experiencePayoutStatus({ status: "connect", payout: "READY", direct: null })).toEqual({ label: "登録済み", tone: "ok" });
    expect(Object.keys(CONNECT_PAYOUT_STATES)).toHaveLength(7);
  });

  it("knows the onboarding outcomes that come back in ?payout=", () => {
    for (const outcome of ["connectForbidden", "connectSeller", "connectUnavailable", "connectReview", "connectNotStarted"]) {
      expect(payoutConsentOutcomeOrNull(outcome)).toBe(outcome);
      expect(PAYOUT_CONSENT_OUTCOMES[outcome as keyof typeof PAYOUT_CONSENT_OUTCOMES].tone).toBe("error");
    }
  });
});

/* 自分の Stripe アカウント (#726, 3c-1): the block beside the payout account, and what a seller that has one shows. */
const section = (state: ConnectPayoutState, over: Partial<DirectPayoutSection> = {}): DirectPayoutSection => ({
  state, providerName: "合成の主催者", accountLast4: "0001", consentVersion: "consent-v1", disclosure: "ready", ...over,
});
const renderLoad = (load: ExperiencePayoutLoad) => renderToStaticMarkup(createElement(HostPayoutAccountPanel, { providerId: "provider-a", load, notice: null })).replace(/<!-- -->/g, "");
const DIRECT_ONBOARD = 'action="/host/api/direct-account/onboarding?providerId=provider-a"';
const DIRECT_SELLER = 'action="/host/api/direct-account/seller?providerId=provider-a"';

describe("受取口座 with the host's own Stripe account", () => {
  it("shows only the payout block while the standard flag is off, and only the direct block when the payout flag is", () => {
    const payoutOnly = renderLoad({ status: "connect", payout: "NOT_STARTED", direct: null });
    expect(payoutOnly).toContain("サポート 15% の受取口座");
    expect(payoutOnly).not.toContain("自分の Stripe アカウント");
    const directOnly = renderLoad({ status: "connect", payout: null, direct: section("NOT_STARTED", { accountLast4: null }) });
    expect(directOnly).toContain("自分の Stripe アカウントで販売する");
    expect(directOnly).toContain(DIRECT_ONBOARD);
    expect(directOnly).not.toContain("サポート 15% の受取口座");
    const both = renderLoad({ status: "connect", payout: "READY", direct: section("NOT_STARTED") });
    expect(both).toContain("サポート 15% の受取口座");
    expect(both).toContain("自分の Stripe アカウントで販売する");
  });

  it.each([
    ["IN_PROGRESS", "Stripe で続きを入力する"],
    ["ACTION_REQUIRED", "Stripe で入力する"],
  ] as const)("%s offers %s", (state, button) => {
    const html = renderLoad({ status: "connect", payout: null, direct: section(state) });
    expect(html).toContain(button);
    expect(html).toContain(DIRECT_ONBOARD);
    expect(html).not.toContain(DIRECT_SELLER);
  });

  it("VERIFYING, REJECTED and unknown have no button", () => {
    for (const state of ["VERIFYING", "REJECTED", "unknown"] as const) {
      expect(renderLoad({ status: "connect", payout: null, direct: section(state) })).not.toContain("<button");
    }
  });

  it("READY asks for the consent with the payout-account consent's text, one checkbox and one button", () => {
    const html = renderLoad({ status: "connect", payout: null, direct: section("READY") });
    expect(html).toContain(DIRECT_SELLER);
    expect(html).toContain('name="accountLast4" value="0001"');
    expect(html).toContain('name="consentVersion" value="consent-v1"');
    expect(html).toContain("末尾 0001");
    expect(html).toContain('name="accepted"');
    expect(html).toContain("同意する");
    expect(html).not.toContain(DIRECT_ONBOARD);
    expect(html).not.toContain("acct_");
  });

  it("READY with no seller disclosure asks for it first, with no consent form", () => {
    const html = renderLoad({ status: "connect", payout: null, direct: section("READY", { disclosure: "missing" }) });
    expect(html).toContain("特定商取引法に基づく表記");
    expect(html).toContain('href="/host/seller?providerId=provider-a"');
    expect(html).not.toContain(DIRECT_SELLER);
  });

  it("READY with no configured consent version cannot take the consent", () => {
    const html = renderLoad({ status: "connect", payout: null, direct: section("READY", { consentVersion: "" }) });
    expect(html).toContain("同意の受付は準備中です");
    expect(html).not.toContain(DIRECT_SELLER);
  });

  it("the pill follows the payout block, else the direct block", () => {
    expect(experiencePayoutStatus({ status: "connect", payout: null, direct: section("READY") })).toEqual(DIRECT_PAYOUT_STATES.READY.pill);
    expect(experiencePayoutStatus({ status: "connect", payout: "VERIFYING", direct: section("READY") })).toEqual(CONNECT_PAYOUT_STATES.VERIFYING.pill);
  });

  it("a seller with its own account opens the dashboard, and keeps the Express block while NIHO still sends it money", () => {
    const owner: ExperiencePayoutLoad = {
      status: "owner", providerName: "合成の主催者", accountLast4: "0001", stripe: "ready", problems: [], consent: { state: "current", consentedAtUtc: "2026-11-28T00:00:00.000Z" }, consentVersion: "consent-v1",
    };
    const plain = renderLoad(owner);
    expect(plain).toContain("サポート 15%（NIHO が代金を受け取る）の体験は止まりません");
    expect(plain).not.toContain("/host/api/stripe-login");
    expect(plain).not.toContain("サポート 15% の受取口座");
    const standard = renderLoad({ ...owner, standard: true, payout: "NOT_STARTED" });
    expect(standard).toContain('action="/host/api/stripe-login"');
    expect(standard).toContain("Stripe で見る");
    expect(standard).toContain("サポート 15% の受取口座");
    expect(standard).toContain('action="/host/api/payout-account/onboarding?providerId=provider-a"');
  });

  it("knows the direct outcomes that come back in ?payout=", () => {
    for (const outcome of ["directRegistered", "directForbidden", "directSeller", "directUnavailable", "directReview", "directNotStarted", "directNotReady", "directDisclosure", "directProfile", "directChanged", "directUnchecked"]) {
      expect(payoutConsentOutcomeOrNull(outcome)).toBe(outcome);
    }
    expect(PAYOUT_CONSENT_OUTCOMES.directRegistered.tone).toBe("success");
  });
});
