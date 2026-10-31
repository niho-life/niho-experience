import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { ExperienceProviderPageListItem } from "@niho-experience/api-client/host";

/** 体験 with provider operations on (http mode): NIHO's pages in the preview's rows, with the experience DB's ★ (#108). */
const state = vi.hoisted(() => ({
  providerOperations: true,
  ratings: null as null | Mock<(...args: unknown[]) => Promise<unknown>>,
}));
vi.mock("server-only", () => ({}));
vi.mock("@/host/data", () => ({
  hostPageContext: async () => ({
    session: { nihoUserId: "sample-niho-user" },
    providers: [],
    provider: { id: "sample-provider", displayName: "Synthetic provider", memberRole: "OWNER" },
    providerNotFound: false,
    linkProviderId: "sample-provider",
  }),
  loadHostConsoleData: async () => ({ experiences: [] }),
  loadHostReviews: () => ({ list: { status: "unavailable" } }),
}));
vi.mock("@/host/experience-ratings-server", () => ({ loadExperienceRatings: (...args: unknown[]) => state.ratings!(...args) }));
vi.mock("@/lib/host/provider-operations-server", () => ({ providerOperationsEnabled: () => state.providerOperations }));

import HostExperiencesPage from "./page";
import { HostLiveExperienceRow, HostLiveExperiences } from "@/components/host/HostLiveExperiences";

const RATINGS = { "sample-walk": { productId: "walk", average: "4.8", count: 5 } };
const page = (overrides: Partial<ExperienceProviderPageListItem> = {}): ExperienceProviderPageListItem => ({
  id: "page-walk", slug: "sample-walk", title: "Synthetic walk", status: "PUBLISHED", language: "EN", coverUrl: null, kind: "EXPERIENCE",
  listOnEntrance: false, updatedAt: "2026-10-30T00:00:00.000Z", bookingCounts: {} as ExperienceProviderPageListItem["bookingCounts"], ...overrides,
});
const row = (item: ExperienceProviderPageListItem, rating?: (typeof RATINGS)["sample-walk"]) =>
  renderToStaticMarkup(createElement("ul", null, createElement(HostLiveExperienceRow, { page: item, rating, linkProviderId: "sample-provider" })));

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}

beforeEach(() => {
  state.providerOperations = true;
  state.ratings = vi.fn(async () => RATINGS);
});

describe("体験 with provider operations on", () => {
  it("passes the OWNER's ★ to NIHO's list, read on the server", async () => {
    const element = await HostExperiencesPage({ searchParams: Promise.resolve({}) });
    const live = elements(element).find((item) => item.type === HostLiveExperiences);
    expect(live?.props).toEqual({ providerId: "sample-provider", linkProviderId: "sample-provider", ratings: RATINGS });
    expect(state.ratings).toHaveBeenCalledWith(expect.objectContaining({ id: "sample-provider" }), "sample-niho-user");
  });

  it("keeps the preview's list and reads no ★ from the experience DB with provider operations off", async () => {
    state.providerOperations = false;
    const element = await HostExperiencesPage({ searchParams: Promise.resolve({}) });
    expect(elements(element).some((item) => item.type === HostLiveExperiences)).toBe(false);
    expect(state.ratings).not.toHaveBeenCalled();
  });
});

describe("a row of NIHO's pages", () => {
  it("looks like the preview's: the title over the row, the language, the ★ link to the experience's reviews, a pill", () => {
    const html = row(page(), RATINGS["sample-walk"]);
    expect(html).toContain('href="/host/experiences/page-walk?providerId=sample-provider"');
    expect(html).toContain("after:absolute after:inset-0");
    expect(html).toContain(">Synthetic walk</a>");
    expect(html).toContain('<p class="text-[0.78125rem] leading-normal text-muted">英語</p>');
    expect(html).toContain('href="/host/reviews?experience=walk&amp;providerId=sample-provider"');
    expect(html).toContain("relative z-[1]");
    expect(html.replace(/<[^>]+>/g, "")).toContain("レビュー ★ 4.8 点 · 5 件");
    expect(html).toContain("公開中");
    expect(html).toContain("max-md:hidden");
  });

  it("names each state of a page, and has no ★ without published reviews", () => {
    expect(row(page({ status: "DRAFT", title: "", language: "JA" }))).toMatch(/題名なし[\s\S]*日本語[\s\S]*下書き/);
    expect(row(page({ status: "UNPUBLISHED" }))).toContain("停止中");
    expect(row(page())).not.toContain("/host/reviews");
  });
});
