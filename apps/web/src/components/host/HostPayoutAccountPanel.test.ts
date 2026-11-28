import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { CONNECT_PAYOUT_STATES, experiencePayoutStatus, hostPayoutLoadOf, PAYOUT_CONSENT_OUTCOMES, payoutConsentOutcomeOrNull, type ConnectPayoutState } from "@/host/payout-account";
import { HostPayoutAccountPanel } from "./HostPayoutAccountPanel";

/* 設定 › 受取口座 for a host that registers its own account (#710): the six states, their words and their one button. */
const render = (state: ConnectPayoutState) => renderToStaticMarkup(
  createElement(HostPayoutAccountPanel, { providerId: "provider-a", load: { status: "connect", state }, notice: null }),
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
    expect(hostPayoutLoadOf({ status: "connect", state: "READY" })).toMatchObject({ status: "owner", payout: { reason: "NOT_CONNECTED" } });
    expect(experiencePayoutStatus({ status: "connect", state: "READY" })).toEqual({ label: "登録済み", tone: "ok" });
    expect(Object.keys(CONNECT_PAYOUT_STATES)).toHaveLength(7);
  });

  it("knows the onboarding outcomes that come back in ?payout=", () => {
    for (const outcome of ["connectForbidden", "connectSeller", "connectUnavailable", "connectReview", "connectNotStarted"]) {
      expect(payoutConsentOutcomeOrNull(outcome)).toBe(outcome);
      expect(PAYOUT_CONSENT_OUTCOMES[outcome as keyof typeof PAYOUT_CONSENT_OUTCOMES].tone).toBe("error");
    }
  });
});
