import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GUEST_REVIEW_LIMITS, type PublicGuestReview, type PublicGuestReviews } from "@niho-experience/experience-store";

/** The experience page's reviews from a stubbed experience store (#104). */
const state = vi.hoisted(() => ({ repository: null as null | Record<string, ReturnType<typeof vi.fn>> }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: { journeyApi: "off" } }));
vi.mock("@/lib/experience/store-server", () => ({ guestReviewRepository: () => state.repository, guestQuestionRepository: () => null }));

import { getLiveReviews, getReviewSummaries } from "./journey";
import { reviewDisplay, reviewHeadline } from "./reviews-ui";
import { reviewsForJsonLd } from "./structured-data";

const item = (index: number, extra: Partial<PublicGuestReview> = {}): PublicGuestReview => ({
  id: `00000000-0000-4000-8000-00000000010${index}`,
  rating: 5,
  body: `Synthetic review ${index}.`,
  tags: [],
  displayName: `Sample Guest ${index}`,
  originLabel: null,
  publishedAt: `2026-10-${20 + index}T01:00:00.000Z`,
  fromBooking: true,
  reply: null,
  ...extra,
});
const answer = (count: number, average: number | null, reviews: PublicGuestReview[], tags: PublicGuestReviews["summary"]["tags"] = []): PublicGuestReviews => ({ summary: { count, average, tags }, reviews });

beforeEach(() => {
  state.repository = {
    listPublishedReviews: vi.fn(async () => answer(0, null, [])),
    listPublishedReviewSummaries: vi.fn(async () => new Map([
      ["sample-tea", { count: 2, average: 4.5, tags: [{ label: "Great host", count: 2 }] }],
      ["sample-new", { count: 0, average: null, tags: [] }],
    ])),
  };
});

describe("getReviewSummaries", () => {
  it("reads every card slug in one store call and only returns real review lines", async () => {
    const summaries = await getReviewSummaries(["sample-tea", "sample-new"]);
    expect(state.repository?.listPublishedReviewSummaries).toHaveBeenCalledOnce();
    expect(state.repository?.listPublishedReviewSummaries).toHaveBeenCalledWith(["sample-tea", "sample-new"]);
    expect([...summaries]).toEqual([["sample-tea", { count: 2, average: 4.5, tags: [{ label: "Great host", count: 2 }] }]]);
  });

  it.each([
    { bound: "count", slugs: Array.from({ length: 101 }, (_, index) => `sample-${index}`) },
    { bound: "total characters", slugs: Array.from({ length: 60 }, (_, index) => `sample-${index}`.padEnd(160, "x")) },
  ])("preserves every summary when a catalog exceeds the $bound bound", async ({ slugs }) => {
    const summary = { count: 3, average: 5, tags: [] };
    const batches: string[][] = [];
    state.repository!.listPublishedReviewSummaries!.mockImplementation(async (batch: string[]) => {
      expect(batch.length).toBeLessThanOrEqual(GUEST_REVIEW_LIMITS.publicSummarySlugsMax);
      expect(batch.reduce((sum, slug) => sum + slug.length, 0)).toBeLessThanOrEqual(GUEST_REVIEW_LIMITS.publicSummarySlugCharactersMax);
      batches.push(batch);
      return new Map(batch.map((slug) => [slug, summary]));
    });
    const summaries = await getReviewSummaries([...slugs, ...slugs]);
    expect(batches).toHaveLength(2);
    expect(batches.flat()).toEqual(slugs);
    expect([...summaries]).toEqual(slugs.map((slug) => [slug, summary]));
  });

  it("does not turn a failed aggregate read into a zero-review summary", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    state.repository!.listPublishedReviewSummaries!.mockRejectedValueOnce(new TypeError("synthetic private review"));
    expect(await getReviewSummaries(["sample-tea"])).toEqual(new Map());
    expect(logged).toHaveBeenCalledWith("Experience card guest review summaries failed", { error: "TypeError" });
    expect(JSON.stringify(logged.mock.calls)).not.toContain("synthetic private review");
  });
});
afterEach(() => vi.restoreAllMocks());

describe("getLiveReviews", () => {
  it("shows no reviews part while the flag is off or there is no DB", async () => {
    const repository = state.repository;
    state.repository = null;
    expect(await getLiveReviews("sample-tea")).toBeNull();
    expect(repository?.listPublishedReviews).not.toHaveBeenCalled();
  });

  it("shows none for an experience the experience DB does not publish", async () => {
    state.repository!.listPublishedReviews!.mockResolvedValueOnce(null);
    expect(await getLiveReviews("sample-unknown")).toBeNull();
    expect(state.repository?.listPublishedReviews).toHaveBeenCalledWith("sample-unknown", { limit: 3 });
  });

  it("reads no reviews yet as New, one as the count and its words, three or more with the average", async () => {
    const none = await getLiveReviews("sample-tea");
    expect(none).toEqual({ status: "ok", summary: { count: 0, average: null, tags: [] }, items: [] });
    expect(reviewDisplay(none)).toEqual({ kind: "none" });
    expect(reviewHeadline(reviewDisplay(none))).toEqual({ label: "New", isNew: true });

    const reply = { hostName: "Sample Seller", body: "Thank you for coming." };
    state.repository!.listPublishedReviews!.mockResolvedValueOnce(answer(1, 4, [item(1, { rating: 4, reply })]));
    const one = await getLiveReviews("sample-tea");
    expect(one).toEqual({ status: "ok", summary: { count: 1, average: 4, tags: [] }, items: [item(1, { rating: 4, reply })] });
    expect(reviewDisplay(one)).toEqual({ kind: "few", count: 1 });
    expect(reviewsForJsonLd(one)).toBeNull();

    // Five shown, the newest three on the page: "Show all 5 reviews" reads the rest. No good points picked yet.
    state.repository!.listPublishedReviews!.mockResolvedValueOnce(answer(5, 4.6, [item(3), item(2), item(1)]));
    const five = await getLiveReviews("sample-tea");
    expect(reviewDisplay(five)).toEqual({ kind: "rated", count: 5, average: 4.6 });
    expect(five?.status === "ok" && five.summary.count > five.items.length).toBe(true);
    expect(five?.status === "ok" && five.summary.tags).toEqual([]);
    expect(reviewsForJsonLd(five)).toEqual({ count: 5, average: 4.6, items: [item(3), item(2), item(1)] });

    state.repository!.listPublishedReviews!.mockResolvedValueOnce(answer(3, 5, [item(3), item(2), item(1)], [{ label: "Great host", count: 2 }]));
    expect(await getLiveReviews("sample-tea")).toMatchObject({ status: "ok", summary: { tags: [{ label: "Great host", count: 2 }] } });
  });

  it("says the reviews could not be read when the DB fails, logging the error's name only", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    state.repository!.listPublishedReviews!.mockRejectedValueOnce(new TypeError("synthetic body: Sample Guest wrote this"));
    const failed = await getLiveReviews("sample-tea");
    expect(failed).toEqual({ status: "unavailable" });
    expect(reviewDisplay(failed)).toEqual({ kind: "unavailable" });
    expect(reviewsForJsonLd(failed)).toBeNull();
    expect(logged).toHaveBeenCalledWith("Experience page guest reviews failed", { error: "TypeError" });
    expect(JSON.stringify(logged.mock.calls)).not.toContain("Sample Guest");
  });
});
