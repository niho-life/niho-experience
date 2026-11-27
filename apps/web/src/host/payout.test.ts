import { describe, expect, it } from "vitest";
import { hostLandingPath } from "@/lib/host/routes";
import {
  PAYOUT_OWNER_ONLY_TEXT,
  PAYOUT_UNREADABLE_TEXT,
  payoutPanelView,
  READINESS_TEXT,
  reviewRow,
  salesPayoutNotice,
  saveNeedsReviewConfirm,
  type HostPayout,
  type HostPayoutLoad,
  type ReviewState,
} from "./payout";

const CONSENT = { version: "sample-payment-reuse-consent-1", text: "合成の同意文" };
const owner = (payout: Partial<HostPayout>): HostPayoutLoad => ({ status: "owner", payout: { reason: "NOT_CONNECTED", sharedFrom: null, candidates: [], reuseConsent: CONSENT, ...payout } });

describe("payout account panel", () => {
  it("says what each state needs and offers the owner the next step", () => {
    const reasons = ["NOT_CONNECTED", "VERIFICATION_REQUIRED", "CHARGES_DISABLED", "PAYOUTS_DISABLED", "RESTRICTED", "READY"] as const;
    const rows = reasons.map((reason) => {
      const view = payoutPanelView(owner({ reason }), "サンプルの台所");
      return [reason, view.status?.label, view.text, view.actions, view.dashboard];
    });
    expect(rows).toEqual([
      ["NOT_CONNECTED", "未接続", "売上を受け取る口座を接続してください。", ["connect"], false],
      ["VERIFICATION_REQUIRED", "確認が必要", "Stripe で本人確認の続きを入力してください。", ["resume", "sync"], false],
      ["CHARGES_DISABLED", "確認が必要", READINESS_TEXT.CHARGES_DISABLED, ["sync"], false],
      ["PAYOUTS_DISABLED", "確認が必要", READINESS_TEXT.PAYOUTS_DISABLED, ["sync"], false],
      ["RESTRICTED", "確認が必要", READINESS_TEXT.RESTRICTED, ["sync"], false],
      ["READY", "準備済み", "サンプルの台所の口座", [], true],
    ]);
  });

  it("offers a spot's ready account only when there is one and NIHO's consent to give", () => {
    const spots = [{ id: "sample-spot-house", name: "サンプルの拠点" }];
    expect(payoutPanelView(owner({ candidates: spots }), "庭").actions).toEqual(["connect", "share"]);
    expect(payoutPanelView(owner({ candidates: spots, reuseConsent: null }), "庭").actions).toEqual(["connect"]);
    expect(payoutPanelView(owner({ candidates: [] }), "庭").actions).toEqual(["connect"]);
  });

  it("names a shared account, and sends a shared one that is not ready back to its spot", () => {
    expect(payoutPanelView(owner({ reason: "READY", sharedFrom: "サンプルの拠点" }), "庭")).toEqual({ status: { label: "準備済み", tone: "ok" }, text: "サンプルの拠点の口座を共有中", actions: [], dashboard: true });
    const pending = payoutPanelView(owner({ reason: "VERIFICATION_REQUIRED", sharedFrom: "サンプルの拠点" }), "庭");
    expect(pending.actions).toEqual([]);
    expect(pending.text).toContain("共有しているサンプルの拠点の口座の設定を確かめてください。");
  });

  it("tells anyone but the owner that the state is the owner's to see, and says when it cannot be read", () => {
    expect(payoutPanelView({ status: "not-owner" }, "サンプル工房")).toEqual({ status: null, text: PAYOUT_OWNER_ONLY_TEXT, actions: [], dashboard: false });
    expect(payoutPanelView({ status: "error" }, "サンプル工房")).toEqual({ status: null, text: PAYOUT_UNREADABLE_TEXT, actions: [], dashboard: false });
  });
});

describe("the note on 売上", () => {
  it("leads to the payout account until it is ready", () => {
    expect(salesPayoutNotice(owner({ reason: "READY" }))).toBeNull();
    expect(salesPayoutNotice(owner({ reason: "NOT_CONNECTED" }))).toEqual({ kind: "setup", title: "受取口座の設定が済んでいません", text: "売上を受け取る口座を接続してください。" });
    expect(salesPayoutNotice(owner({ reason: "RESTRICTED" }))).toMatchObject({ kind: "setup", text: READINESS_TEXT.RESTRICTED });
    expect(salesPayoutNotice({ status: "not-owner" })).toEqual({ kind: "owner-only", text: "口座の状態はオーナーが確認できます" });
    expect(salesPayoutNotice({ status: "error" })).toMatchObject({ kind: "unknown" });
  });
});

describe("審査を申請", () => {
  const ready: ReviewState = { reviewStatus: "DRAFT", role: "OWNER", unsaved: false, payoutReady: true, consentCurrent: true };

  it("can be pressed by the owner of a provider not submitted yet, once the payout account is ready", () => {
    expect(reviewRow(ready)).toEqual({ kind: "submit", blocker: null });
  });

  it("says in one line why it waits, the first thing to do first", () => {
    const blocker = (state: Partial<ReviewState>) => {
      const row = reviewRow({ ...ready, ...state });
      return row?.kind === "submit" ? row.blocker : row;
    };
    expect(blocker({ unsaved: true })).toBe("変更を保存すると申請できます。");
    expect(blocker({ payoutReady: false })).toBe("売上受取口座の準備ができると申請できます。");
    expect(blocker({ consentCurrent: false })).toBe("提供者規約への同意が古いため申請できません。NIHO にお問い合わせください。");
  });

  it("is the owner's: an editor reads who does it, and other states say where the review stands", () => {
    expect(reviewRow({ ...ready, role: "EDITOR" })).toEqual({ kind: "note", text: "審査の申請はオーナーが行います。" });
    expect(reviewRow({ ...ready, role: null })).toEqual({ kind: "note", text: "審査の申請はオーナーが行います。" });
    expect(reviewRow({ ...ready, reviewStatus: "REQUESTED" })).toEqual({ kind: "note", text: "NIHO が確認しています。" });
    expect(reviewRow({ ...ready, reviewStatus: "SUSPENDED" })).toMatchObject({ kind: "note" });
    expect(reviewRow({ ...ready, reviewStatus: "APPROVED" })).toBeNull();
    expect(reviewRow({ ...ready, reviewStatus: null })).toBeNull();
  });

  it("asks before saving a reviewed provider, which NIHO sends back to review", () => {
    expect((["DRAFT", "REQUESTED", "APPROVED", "SUSPENDED", null] as const).map(saveNeedsReviewConfirm)).toEqual([false, false, true, true, false]);
  });
});

describe("the way back from Stripe", () => {
  it("lands a signed-in host on 設定 when Stripe sends them back to /host, else on the home", () => {
    expect(hostLandingPath("sample-provider-garden", "return")).toBe("/host/settings?providerId=sample-provider-garden&connect=return");
    expect(hostLandingPath("sample-provider-garden", "refresh")).toBe("/host/settings?providerId=sample-provider-garden&connect=refresh");
    expect(hostLandingPath(null, "return")).toBe("/host/settings?connect=return");
    expect(hostLandingPath("sample-provider-garden", "elsewhere")).toBe("/host/home?providerId=sample-provider-garden");
    expect(hostLandingPath(null, ["return"])).toBe("/host/home");
  });
});
