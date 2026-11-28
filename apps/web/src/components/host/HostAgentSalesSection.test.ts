import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HostAgentSalesSection, agentSalesChoosable, type AgentSalesProduct } from "./HostAgentSalesSection";

/* 代理受領の欄 (#725): when the host sees the choice, the current plan, and when it can choose again. Static markup only. */
const offer = { agreementVersion: "agent-sales-v2", receiverName: "Synthetic NIHO Receiver KK", payoutDelayDays: 3, sellerName: "合成 販売者" };
const plan = (over: Record<string, unknown> = {}) => ({ current: { revision: 1, agreementVersion: "agent-sales-v2", chargeMode: "PLATFORM", sellerParty: "PROVIDER", ...over } });
const product = (over: Partial<AgentSalesProduct> = {}): AgentSalesProduct => ({ bookingOpen: false, agentSales: offer, salesPlan: null, ...over });
const html = (value: AgentSalesProduct, extra: { accepted?: boolean; busy?: boolean } = {}) => renderToStaticMarkup(createElement(HostAgentSalesSection, {
  product: value, busy: extra.busy ?? false, dirty: false, accepted: extra.accepted ?? false, onAccept: () => undefined, retrying: false, onChoose: () => undefined, sellerHref: "/host/seller",
}));
const words = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("the agent-sales section of 料金・予約", () => {
  it("shows the choice and its consent to a host with no seller profile (flag on), with the version and the terms link", () => {
    const text = words(html(product()));
    expect(text).toContain("サポート 15%（NIHO が代金を受け取る）");
    expect(text).toContain("Synthetic NIHO Receiver KK");
    expect(text).toContain("3日後");
    expect(text).toContain("同意版 agent-sales-v2");
    expect(html(product())).toContain('href="/host/terms"');
    expect(html(product())).toContain("この方法で売る");
    expect(html(product())).toContain("disabled");
  });

  it("shows nothing for a host with no offer (flag off, or it has a seller profile)", () => {
    expect(html(product({ agentSales: null }))).toBe("");
    expect(html(product({ agentSales: undefined }))).toBe("");
  });

  it("asks for the public seller disclosure first when there is none", () => {
    const markup = html(product({ agentSales: { ...offer, sellerName: null } }), { accepted: true });
    expect(words(markup)).toContain("先に 販売者表示 で");
    expect(markup).toContain('href="/host/seller"');
  });

  it("says what is chosen once the plan is agent sales, and does not offer the choice again while it is current", () => {
    const current = product({ salesPlan: plan(), agentSales: { ...offer, planSellerName: "合成 販売者", consentCounted: true } });
    const text = words(html(current));
    expect(text).toContain("販売者はあなたです");
    expect(text).toContain("版 1");
    expect(text).not.toContain("この方法で売る");
    expect(agentSalesChoosable(current)).toBe(false);
  });

  it("never offers the choice again to a host that has its own Stripe account now (choosable: false), though the plan is still shown", () => {
    const base = { salesPlan: plan({ agreementVersion: "old" }), agentSales: { ...offer, planSellerName: "合成 販売者", consentCounted: false, choosable: false as const } };
    expect(agentSalesChoosable(product(base))).toBe(false);
    expect(words(html(product(base)))).toContain("販売者はあなたです");
  });

  it("offers the choice again only while bookings are stopped, and for the three reasons: a new consent version, a consent that no longer counts, another name", () => {
    const base = { salesPlan: plan(), agentSales: { ...offer, planSellerName: "合成 販売者", consentCounted: true } };
    expect(agentSalesChoosable(product(base))).toBe(false);
    expect(agentSalesChoosable(product({ ...base, salesPlan: plan({ agreementVersion: "agent-sales-v1" }) }))).toBe(true);
    expect(agentSalesChoosable(product({ ...base, agentSales: { ...base.agentSales, consentCounted: false } }))).toBe(true);
    expect(agentSalesChoosable(product({ ...base, agentSales: { ...base.agentSales, planSellerName: "古い名前" } }))).toBe(true);
    // A name not saved yet is not a mismatch; the missing disclosure is said by its own notice.
    expect(agentSalesChoosable(product({ ...base, agentSales: { ...base.agentSales, sellerName: null, planSellerName: "古い名前" } }))).toBe(false);
    for (const over of [{ salesPlan: plan({ agreementVersion: "agent-sales-v1" }) }, { agentSales: { ...base.agentSales, consentCounted: false } }, { agentSales: { ...base.agentSales, planSellerName: "古い名前" } }]) {
      expect(agentSalesChoosable(product({ ...base, ...over, bookingOpen: true })), "never while bookings are open").toBe(false);
      expect(html(product({ ...base, ...over, bookingOpen: true }))).not.toContain("この方法で売る");
    }
    expect(html(product({ ...base, salesPlan: plan({ agreementVersion: "agent-sales-v1" }) }))).toContain("この方法で売る");
  });

  it("leaves a product on another plan alone (20% or Direct)", () => {
    expect(agentSalesChoosable(product({ salesPlan: plan({ chargeMode: "CONNECT_DIRECT" }) }))).toBe(false);
    expect(agentSalesChoosable(product({ salesPlan: plan({ sellerParty: "NIHO" }) }))).toBe(false);
  });
});

describe("where the workspace mounts it", () => {
  it("is inside the host's own render (料金・予約), before the admin-only render that follows it", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("./HostPublicationWorkspace.tsx", import.meta.url), "utf8");
    const mount = source.indexOf("<HostAgentSalesSection ");
    const pricing = source.indexOf("const pricingTab = ");
    const hostReturn = source.indexOf("const tabs = [[\"page\"");
    const adminRender = source.indexOf("return <HostPageBody>", hostReturn + 1);
    expect(mount).toBeGreaterThan(pricing);
    expect(mount).toBeLessThan(hostReturn);
    expect(adminRender).toBeGreaterThan(mount);
    expect(source.match(/<HostAgentSalesSection /g)).toHaveLength(1);
  });
});
