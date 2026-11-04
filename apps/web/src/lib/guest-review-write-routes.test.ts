import { beforeEach, describe, expect, it, vi } from "vitest";
import { StoreNotFoundError } from "@niho-experience/experience-store";

const state = vi.hoisted(() => ({
  config: { apiMode: "http", guestReviewsEnabled: true, hostAttendanceEnabled: true, siteUrl: "https://experience.example" },
  repository: null as null | { openInvitation: ReturnType<typeof vi.fn>; submitReview: ReturnType<typeof vi.fn> },
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ get config() { return state.config; } }));
vi.mock("@/lib/experience/store-server", () => ({ guestReviewRepository: () => state.repository }));

import { POST as open } from "@/app/api/public/reviews/open/route";
import { POST as submit } from "@/app/api/public/reviews/route";

const token = "a".repeat(43);
const invitation = { experienceTitle: "Synthetic tea", hostDisplayName: "Sample Host", sessionStartUtc: "2026-11-01T01:00:00.000Z", expiresAtUtc: "2026-11-15T01:00:00.000Z" };
const review = { token, rating: 5, body: "A lovely afternoon", displayName: "Sample Guest", tags: ["GREAT_HOST"], clientRequestKey: "sample-review-key" };
const request = (path: string, body: unknown, origin = "https://experience.example") => new Request(`https://experience.example${path}`, {
  method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify(body),
});

beforeEach(() => {
  state.config = { apiMode: "http", guestReviewsEnabled: true, hostAttendanceEnabled: true, siteUrl: "https://experience.example" };
  state.repository = { openInvitation: vi.fn(async () => invitation), submitReview: vi.fn(async () => ({ status: "received" })) };
});

describe("guest review invitation and submission routes", () => {
  it("opens without consuming a link, then submits the bounded review with no-store responses", async () => {
    const opened = await open(request("/api/public/reviews/open", { token }));
    expect(opened.status).toBe(200);
    expect(await opened.json()).toEqual({ invitation });
    expect(opened.headers.get("referrer-policy")).toBe("no-referrer");
    expect(state.repository?.submitReview).not.toHaveBeenCalled();
    const posted = await submit(request("/api/public/reviews", review));
    expect(posted.status).toBe(201);
    expect(posted.headers.get("cache-control")).toBe("no-store");
    expect(state.repository?.submitReview).toHaveBeenCalledWith(token, {
      rating: 5, body: "A lovely afternoon", displayName: "Sample Guest", tags: ["GREAT_HOST"],
      originLabel: null, noteToHost: null, clientRequestKey: "sample-review-key", language: "EN",
    });
  });

  it("accepts the language handoff value for a localized client", async () => {
    expect((await submit(request("/api/public/reviews", { ...review, language: "JA" }))).status).toBe(201);
    expect(state.repository?.submitReview).toHaveBeenCalledWith(token, expect.objectContaining({ language: "JA" }));
    expect((await submit(request("/api/public/reviews", { ...review, language: "FR" }))).status).toBe(422);
  });

  it("keeps cross-origin, invalid and no-show or expired links closed", async () => {
    expect((await open(request("/api/public/reviews/open", { token }, "https://other.example"))).status).toBe(403);
    expect((await submit(request("/api/public/reviews", { ...review, rating: 6 }))).status).toBe(422);
    state.repository!.openInvitation.mockResolvedValueOnce(null);
    expect((await open(request("/api/public/reviews/open", { token }))).status).toBe(404);
    state.repository!.submitReview.mockRejectedValueOnce(new StoreNotFoundError("review link"));
    expect((await submit(request("/api/public/reviews", review))).status).toBe(404);
    state.config.hostAttendanceEnabled = false;
    expect((await submit(request("/api/public/reviews", review))).status).toBe(404);
  });
});
