import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { StoreAccessDeniedError, StoreError, type HostProductRating } from "@niho-experience/experience-store";

/** 体験の一覧's ★ in http mode (#108), against a stubbed aggregate of the reviews. */
type ByProduct = Mock<(...args: unknown[]) => Promise<readonly HostProductRating[]>>;
const state = vi.hoisted(() => ({
  mock: false,
  byProduct: null as null | ByProduct,
  store: true,
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/host/server", () => ({ isHostMock: () => state.mock }));
vi.mock("@/lib/experience/store-server", () => ({ guestReviewRatings: () => (state.store ? { byProduct: state.byProduct } : null) }));

import { loadExperienceRatings } from "./experience-ratings-server";

const OWNER = { id: "sample-provider", memberRole: "OWNER" } as const;
const ACTOR = { providerId: "sample-provider", nihoUserId: "sample-owner", calendarRoleCeiling: "OWNER" };

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  state.mock = false;
  state.store = true;
  state.byProduct = vi.fn(async () => [
    // More than レビュー's first page reads: the store counts them all.
    { productId: "walk", slug: "sample-walk", count: 130, average: "4.6" },
    { productId: "tea", slug: "sample-tea", count: 1, average: "5.0" },
  ]);
});

describe("loadExperienceRatings", () => {
  it("gives each reviewed experience the store's average and count of all its reviews by its slug, with the product レビュー filters by", async () => {
    expect(await loadExperienceRatings(OWNER, "sample-owner")).toEqual({
      "sample-walk": { productId: "walk", average: "4.6", count: 130 },
      "sample-tea": { productId: "tea", average: "5.0", count: 1 },
    });
    expect(state.byProduct).toHaveBeenCalledWith(ACTOR);
  });

  it("is empty without reviews, for anyone else, closed, when the store does not count the OWNER, or when the read fails", async () => {
    state.byProduct!.mockResolvedValueOnce([]);
    expect(await loadExperienceRatings(OWNER, "sample-owner")).toEqual({});
    expect(await loadExperienceRatings({ id: "sample-provider", memberRole: "EDITOR" }, "sample-owner")).toEqual({});
    expect(state.byProduct).toHaveBeenCalledTimes(1);

    state.byProduct!.mockRejectedValueOnce(new StoreAccessDeniedError());
    expect(await loadExperienceRatings(OWNER, "sample-owner")).toEqual({});
    expect(console.error).not.toHaveBeenCalled();
    state.byProduct!.mockRejectedValueOnce(new StoreError("Database returned an invalid review rating."));
    expect(await loadExperienceRatings(OWNER, "sample-owner")).toEqual({});
    expect(console.error).toHaveBeenCalledWith("Experience ratings read failed", { error: "StoreError" });

    state.store = false;
    expect(await loadExperienceRatings(OWNER, "sample-owner")).toEqual({});
    state.store = true;
    state.mock = true;
    expect(await loadExperienceRatings(OWNER, "sample-owner")).toEqual({});
    expect(state.byProduct).toHaveBeenCalledTimes(3);
  });
});
