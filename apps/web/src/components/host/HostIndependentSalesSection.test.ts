import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HostIndependentSalesSection, independentSalesAction, type IndependentSalesProduct } from "./HostIndependentSalesSection";

/* 独立 10% の欄 (3c-2, #726): the choice for a product with no plan, the switch from 代理受領, the current plan. Static markup only. */
const offer = { agreementVersion: "independent-sales-v2", sellerName: "合成 販売者" };
const plan = (over: Record<string, unknown> = {}, phase = "ACTIVE") => ({ phase, current: { revision: 1, plan: "SUPPORTED_15", agreementVersion: "agent-sales-v1", chargeMode: "PLATFORM", sellerParty: "PROVIDER", ...over } });
const independent = () => plan({ plan: "INDEPENDENT_10", chargeMode: "CONNECT_DIRECT" });
const product = (over: Partial<IndependentSalesProduct> = {}): IndependentSalesProduct => ({ independentSales: offer, salesPlan: null, ...over });
const html = (value: IndependentSalesProduct, extra: { accepted?: boolean; busy?: boolean; retrying?: boolean } = {}) => renderToStaticMarkup(createElement(HostIndependentSalesSection, {
  product: value, busy: extra.busy ?? false, dirty: false, accepted: extra.accepted ?? false, onAccept: () => undefined, retrying: extra.retrying ?? false, onChoose: () => undefined,
}));
const words = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("the 独立 10% section of 料金・予約", () => {
  it("offers the choice, with the wording, the version and the terms link, to a host with its own Stripe account and a product with no plan", () => {
    const text = words(html(product()));
    expect(text).toContain("独立 10%（自分の Stripe で販売）");
    expect(text).toContain("販売者はあなた（合成 販売者）");
    expect(text).toContain("あなたの Stripe アカウントで直接受け取ります");
    expect(text).toContain("料率は10%です（決済手数料こみ。NIHO が補います）");
    expect(text).toContain("返金・異議申立ての損失は、あなたの負担");
    expect(text).toContain("同意版 independent-sales-v2");
    expect(html(product())).toContain('href="/host/terms"');
    expect(html(product())).toContain("独立 10% で売る");
    expect(html(product())).toContain("disabled");
    expect(html(product(), { accepted: true })).not.toContain("disabled");
    expect(independentSalesAction(product())).toBe("choose");
  });

  it("shows nothing for a host with no offer (flag off, or its seller is not its own Stripe account)", () => {
    expect(html(product({ independentSales: null }))).toBe("");
    expect(html(product({ independentSales: undefined }))).toBe("");
  });

  it("offers the switch for a product sold with 代理受領, also while bookings are open, and says what happens to the bookings taken", () => {
    const sold = product({ salesPlan: plan() });
    expect(independentSalesAction(sold)).toBe("switch");
    const text = words(html(sold, { accepted: true }));
    expect(text).toContain("独立 10% に切り替える");
    expect(text).toContain("受付中でも切り替えられます");
    expect(text).toContain("今までどおり受取口座へ送金されます");
    expect(words(html(sold, { retrying: true }))).toContain("同じ操作の結果を確認");
    // Not while a switch is in progress.
    expect(independentSalesAction(product({ salesPlan: plan({}, "RECONCILING") }))).toBeNull();
  });

  it("shows the current plan once the product is 独立 10%, and does not offer the choice again", () => {
    const current = product({ salesPlan: independent() });
    const text = words(html(current));
    expect(text).toContain("販売者はあなた（合成 販売者）です。旅行者の代金は、あなたの Stripe アカウントで直接受け取ります（版 1）");
    expect(text).not.toContain("独立 10% で売る");
    expect(independentSalesAction(current)).toBeNull();
  });

  it("offers nothing for another plan (the 20% plan)", () => {
    const managed = product({ salesPlan: plan({ plan: "MANAGED_20", chargeMode: "PLATFORM", sellerParty: "NIHO" }) });
    expect(independentSalesAction(managed)).toBeNull();
    expect(html(managed)).toBe("");
  });

  it("offers to resume a switch to 独立 10% that stopped half way, with no new consent, and not for another pending plan", () => {
    const stopped = product({ salesPlan: { ...plan({}, "RECONCILING"), pending: { plan: "INDEPENDENT_10", agreementVersion: "independent-sales-v1" }, transitionCommandId: "cmd-1" } });
    expect(independentSalesAction(stopped)).toBe("resume");
    const text = words(html(stopped));
    expect(text).toContain("旧決済の照合を再開");
    expect(text).not.toContain("同意版");
    expect(independentSalesAction(product({ salesPlan: { ...plan({}, "RECONCILING"), pending: { plan: "SUPPORTED_15" }, transitionCommandId: "cmd-1" } }))).toBeNull();
  });
});
