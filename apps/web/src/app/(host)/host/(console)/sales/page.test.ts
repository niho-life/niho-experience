import { isValidElement, Suspense, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { SalesPage } from "@/host/sales";

type Load = Mock<(...args: unknown[]) => Promise<unknown>>;

/** 売上 with this site's ledger (#91), against stubbed data: which screen the OWNER gets for each load. */
const state = vi.hoisted(() => ({
  role: "OWNER" as string,
  site: { status: "closed" } as Record<string, unknown>,
  loadSiteSales: null as null | Load,
  sales: { status: "unavailable" } as Record<string, unknown>,
  payout: { status: "owner", payout: { reason: "READY", sharedFrom: null, candidates: [], reuseConsent: null } } as Record<string, unknown>,
}));
vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/host/data", () => ({
  hostPageContext: async () => ({
    session: { nihoUserId: "sample-niho-user", idToken: "never-passed-on", refreshToken: "never-passed-on" },
    providers: [],
    provider: { id: "sample-provider", displayName: "Synthetic provider", memberRole: state.role },
    providerNotFound: false,
    linkProviderId: "sample-provider",
  }),
  loadHostPayout: async () => ({ load: state.payout, notice: null, redirectTo: null }),
  loadHostSales: () => state.sales,
}));
vi.mock("@/host/site-sales-server", () => ({ loadSiteSales: (...args: unknown[]) => state.loadSiteSales!(...args) }));

import HostSalesPage from "./page";
import { SalesLines, SalesLoading, SalesPayoutNoticeView, SalesScope, SalesSummaryPanel } from "@/components/host/HostSales";
import { SITE_SALES_LOAD_FAILED_TEXT, SITE_SALES_SCOPE_TEXT } from "@/host/site-sales";

const PAGE: SalesPage = { month: { year: 2026, month: 11 }, label: "2026年11月", previous: null, next: null, figures: [{ label: "売上", value: "¥7,500" }], notes: [], rows: [] };

beforeEach(() => {
  state.role = "OWNER";
  state.site = { status: "closed" };
  state.loadSiteSales = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => state.site);
  state.sales = { status: "unavailable" };
  state.payout = { status: "owner", payout: { reason: "READY", sharedFrom: null, candidates: [], reuseConsent: null } };
});

/** Every element of a tree, rendering the page's own local views (the month, its frame) on the way. */
async function elements(node: ReactNode): Promise<ReactElement<Record<string, unknown>>[]> {
  if (Array.isArray(node)) return (await Promise.all(node.map(elements))).flat();
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  const local = typeof node.type === "function" && ["HostSalesMonth", "SalesFrame"].includes(node.type.name);
  if (local) return [node, ...(await elements(await (node.type as (props: unknown) => ReactNode | Promise<ReactNode>)(node.props)))];
  return [node, ...(await elements(node.props.children as ReactNode))];
}

async function page(month?: string) {
  const root = await HostSalesPage({ searchParams: Promise.resolve(month ? { month } : {}) });
  const all = await elements(root);
  const text = all.flatMap((item) => (typeof item.props.children === "string" ? [item.props.children] : []));
  return { root, all, has: (type: unknown) => all.some((item) => item.type === type), find: (type: unknown) => all.find((item) => item.type === type), text };
}

describe("売上 with this site's ledger", () => {
  it("streams the month after the OWNER check, saying it is being read meanwhile", async () => {
    const view = await page();
    expect(isValidElement(view.root) && view.root.type).toBe(Suspense);
    const fallback = await elements((view.root as ReactElement<{ fallback: ReactNode }>).props.fallback);
    expect(fallback.some((item) => item.type === SalesLoading)).toBe(true);
  });

  it("shows this site's month, said to be this site's only, with the payout note above the numbers", async () => {
    state.site = { status: "live", page: PAGE };
    state.payout = { status: "owner", payout: { reason: "NOT_CONNECTED", sharedFrom: null, candidates: [], reuseConsent: null } };
    const view = await page("2026-11");
    // Who reads, never the session's tokens.
    expect(state.loadSiteSales).toHaveBeenCalledWith(expect.objectContaining({ id: "sample-provider" }), { nihoUserId: "sample-niho-user", mockScenario: undefined }, "2026-11");
    expect(view.find(SalesScope)?.props.text).toBe(SITE_SALES_SCOPE_TEXT);
    expect(view.find(SalesSummaryPanel)?.props.page).toBe(PAGE);
    expect(view.find(SalesLines)?.props.page).toBe(PAGE);
    expect(view.has(SalesPayoutNoticeView)).toBe(true);
  });

  it("says it could not read the ledger, and shows no numbers", async () => {
    state.site = { status: "error" };
    const view = await page();
    expect(view.all.find((item) => item.props.role === "alert")?.props.children).toBe(SITE_SALES_LOAD_FAILED_TEXT);
    expect(view.has(SalesSummaryPanel)).toBe(false);
  });

  it("keeps 準備中 while the ledger is closed to the account", async () => {
    const view = await page();
    expect(view.text).toContain("売上の明細は準備中です");
    expect(view.has(SalesScope)).toBe(false);
  });

  it("is the OWNER's only: anyone else gets a 404 before anything streams", async () => {
    state.role = "EDITOR";
    await expect(HostSalesPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(state.loadSiteSales).not.toHaveBeenCalled();
  });
});
