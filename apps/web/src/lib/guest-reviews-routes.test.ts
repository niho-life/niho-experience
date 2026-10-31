import { beforeEach, describe, expect, it, vi } from "vitest";
import { createExperienceApiClient, type ExperienceReviewsResponse } from "@niho-experience/api-client";
import type { PublicGuestReviews } from "@niho-experience/experience-store";

/** The public read of 予約者のレビュー against a stubbed experience store (#104). */
const state = vi.hoisted(() => ({
  config: { guestReviewsEnabled: true },
  repository: null as null | Record<string, ReturnType<typeof vi.fn>>,
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ get config() { return state.config; } }));
vi.mock("@/lib/experience/store-server", () => ({ guestReviewRepository: () => state.repository }));

import { GET } from "@/app/api/public/experiences/[slug]/reviews/route";

const ORIGIN = "https://experience.example";

/** What the store answers: published reviews only, in the public shape. */
const REVIEWS: PublicGuestReviews = {
  summary: { count: 3, average: 4.3, tags: [{ label: "Great host", count: 2 }, { label: "Calm atmosphere", count: 1 }] },
  reviews: [
    {
      id: "00000000-0000-4000-8000-000000000104",
      rating: 4,
      body: "A calm and lovely afternoon.",
      tags: ["Calm atmosphere", "Great host"],
      displayName: "Sample Guest",
      originLabel: "United Kingdom",
      publishedAt: "2026-10-30T01:00:00.000Z",
      fromBooking: true,
      reply: { hostName: "Sample Seller", body: "Thank you for coming." },
    },
    {
      id: "00000000-0000-4000-8000-000000000105",
      rating: 5,
      body: "Lovely.",
      tags: [],
      displayName: "Sample Traveler",
      originLabel: null,
      publishedAt: "2026-10-29T01:00:00.000Z",
      fromBooking: true,
      reply: null,
    },
  ],
};

function get(path: string): Request {
  return new Request(`${ORIGIN}${path}`, { method: "GET" });
}

const slugParams = (slug = "sample-tea") => ({ params: Promise.resolve({ slug }) });

beforeEach(() => {
  state.config = { guestReviewsEnabled: true };
  state.repository = { listPublishedReviews: vi.fn(async () => REVIEWS) };
});

describe("GET /api/public/experiences/[slug]/reviews", () => {
  it("answers the published reviews with no-store headers", async () => {
    const response = await GET(get("/api/public/experiences/sample-tea/reviews"), slugParams());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(REVIEWS);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(state.repository?.listPublishedReviews).toHaveBeenCalledWith("sample-tea", {});
    await GET(get("/api/public/experiences/sample-tea/reviews?limit=10"), slugParams());
    expect(state.repository?.listPublishedReviews).toHaveBeenLastCalledWith("sample-tea", { limit: 10 });
  });

  it("passes the experience page's own check of the reviews contract", async () => {
    const response = await GET(get("/api/public/experiences/sample-tea/reviews?limit=50"), slugParams());
    const fetchStub = vi.fn(async () => response);
    const client = createExperienceApiClient({ nihoWebOrigin: ORIGIN, thisSite: true, fetch: fetchStub });
    const read = await client.listReviews("sample-tea", { limit: 50 });
    expect(read).toEqual({ ok: true, data: REVIEWS satisfies ExperienceReviewsResponse });
    expect(fetchStub).toHaveBeenCalledWith(`${ORIGIN}/api/public/experiences/sample-tea/reviews?limit=50`, expect.anything());
    // Exactly the contract's keys: nothing private or internal rides along.
    if (!read.ok) throw new Error("unreachable");
    for (const review of read.data.reviews) {
      expect(Object.keys(review).sort()).toEqual(["body", "displayName", "fromBooking", "id", "originLabel", "publishedAt", "rating", "reply", "tags"]);
      if (review.reply) expect(Object.keys(review.reply).sort()).toEqual(["body", "hostName"]);
    }
    expect(Object.keys(read.data).sort()).toEqual(["reviews", "summary"]);
    expect(Object.keys(read.data.summary).sort()).toEqual(["average", "count", "tags"]);
    expect(JSON.stringify(read.data)).not.toMatch(/email|phone|bookingId|bookingPublicId|booking_id|provider|product|noteToHost|note_to_host|japanese|bodyJa|niho_user|report/i);
  });

  it("is a 404 while the flag is off, for an unknown or odd slug, and a 503 without the DB", async () => {
    state.config = { guestReviewsEnabled: false };
    const off = await GET(get("/api/public/experiences/sample-tea/reviews"), slugParams());
    expect(off.status).toBe(404);
    expect(await off.text()).toBe("");
    state.config = { guestReviewsEnabled: true };
    for (const slug of ["", "x".repeat(161)]) expect((await GET(get("/api/public/experiences/x/reviews"), slugParams(slug))).status).toBe(404);
    state.repository!.listPublishedReviews!.mockResolvedValueOnce(null);
    const missing = await GET(get("/api/public/experiences/sample-missing/reviews"), slugParams("sample-missing"));
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe("");
    state.repository = null;
    expect((await GET(get("/api/public/experiences/sample-tea/reviews"), slugParams())).status).toBe(503);
  });

  it("refuses a limit that is not a whole number from 1 to 50", async () => {
    for (const limit of ["0", "51", "-1", "1.5", "abc", "", "007", "1e1", "100000"]) {
      const response = await GET(get(`/api/public/experiences/sample-tea/reviews?limit=${encodeURIComponent(limit)}`), slugParams());
      expect(response.status, limit).toBe(400);
      expect(await response.json()).toEqual({ error: { code: "VALIDATION_ERROR", message: expect.any(String) } });
    }
    expect(state.repository?.listPublishedReviews).not.toHaveBeenCalled();
  });

  it("is a 503 when the store fails, logging only the error's name", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    state.repository!.listPublishedReviews!.mockRejectedValueOnce(new Error("synthetic outage sample-tea"));
    const failed = await GET(get("/api/public/experiences/sample-tea/reviews"), slugParams());
    expect(failed.status).toBe(503);
    expect(log).toHaveBeenCalledWith("Experience guest reviews failed", { error: "Error" });
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/synthetic outage|sample-tea/);
    log.mockRestore();
  });
});
