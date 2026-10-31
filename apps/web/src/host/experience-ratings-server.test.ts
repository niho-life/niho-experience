import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { StoreAccessDeniedError } from "@niho-experience/experience-store";
import type { HostReview } from "./types";

/** 体験の一覧's ★ in http mode (#108), against stubbed reviews and products. */
type Load = Mock<(...args: unknown[]) => Promise<unknown>>;
const state = vi.hoisted(() => ({
  mock: false,
  reviews: null as null | Load,
  slugs: null as null | Load,
  store: true,
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/host/server", () => ({ isHostMock: () => state.mock }));
vi.mock("@/lib/experience/store-server", () => ({ hostCalendarSettings: () => (state.store ? { productSlugs: state.slugs } : null) }));
vi.mock("./guest-reviews-server", () => ({ loadGuestReviews: (...args: unknown[]) => state.reviews!(...args) }));

import { loadExperienceRatings } from "./experience-ratings-server";

const OWNER = { id: "sample-provider", memberRole: "OWNER" } as const;
const review = (id: string, experienceId: string, rating: number): HostReview => ({
  id, experienceId, bookingId: id, sessionDate: "2026-10-30", reviewer: { name: "Sample", country: "" }, rating, tags: [],
  body: { original: "Synthetic", language: "en", translation: null }, privateNote: null, writtenAt: "2026-10-31T10:00", status: "published",
  publishedAt: "2026-10-31T10:00", reply: null, report: null,
});

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  state.mock = false;
  state.store = true;
  state.reviews = vi.fn(async () => ({
    status: "live",
    reviews: [review("r1", "walk", 5), review("r2", "walk", 4), review("r3", "tea", 5)],
    experiences: [{ id: "walk", title: "Synthetic walk" }, { id: "tea", title: "Synthetic tea" }],
  }));
  state.slugs = vi.fn(async () => ({ walk: "sample-walk" }));
});

describe("loadExperienceRatings", () => {
  it("gives each reviewed experience its average and count by its slug, with the product レビュー filters by", async () => {
    expect(await loadExperienceRatings(OWNER, "sample-owner")).toEqual({ "sample-walk": { productId: "walk", average: "4.5", count: 2 } });
    expect(state.reviews).toHaveBeenCalledWith(OWNER, "sample-owner");
    expect(state.slugs).toHaveBeenCalledWith({ providerId: "sample-provider", nihoUserId: "sample-owner", calendarRoleCeiling: "OWNER" });
  });

  it("is empty when the reviews are closed, not the OWNER's, unreadable, or the products cannot be read", async () => {
    for (const status of ["closed", "owner-only", "error"]) {
      state.reviews!.mockResolvedValueOnce({ status });
      expect(await loadExperienceRatings(OWNER, "sample-owner")).toEqual({});
    }
    state.slugs!.mockRejectedValueOnce(new StoreAccessDeniedError());
    expect(await loadExperienceRatings(OWNER, "sample-owner")).toEqual({});
    expect(console.error).toHaveBeenCalledWith("Experience ratings read failed", { error: "StoreAccessDeniedError" });
    state.store = false;
    expect(await loadExperienceRatings(OWNER, "sample-owner")).toEqual({});
    state.store = true;
    state.mock = true;
    expect(await loadExperienceRatings(OWNER, "sample-owner")).toEqual({});
  });
});
