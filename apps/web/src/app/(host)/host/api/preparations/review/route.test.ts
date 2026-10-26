import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ enabled: vi.fn(), allowed: vi.fn(), review: vi.fn(), setGrant: vi.fn(), clearGrant: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@niho-experience/api-client/experience-preparations-schema", () => ({ isExperiencePreparationSchema: (_name: string, value: unknown) => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value) }));
vi.mock("@/lib/preparations/server", () => ({
  isPreparationHttpEnabled: mocks.enabled,
  preparationMutationAllowed: mocks.allowed,
  preparationReviewClient: () => ({ review: mocks.review }),
  readBoundedJson: async (request: Request) => { if (new URL(request.url).search) return { ok: false }; try { return { ok: true, value: await request.json() }; } catch { return { ok: false }; } },
  preparationJson: (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-robots-tag": "noindex, nofollow" } }),
  preparationFailureJson: () => Response.json({ error: "not_found" }, { status: 404 }),
  setPreparationReviewGrant: mocks.setGrant,
  clearPreparationReviewGrant: mocks.clearGrant,
  readPreparationReviewGrant: vi.fn(),
}));

import { POST } from "./route";

const token = "t".repeat(43);
const review = { caseId: "case_1", expiresAt: new Date(Date.now() + 60_000).toISOString(), proposal: {} };
const request = (body: unknown) => new Request("https://experience.example/host/api/preparations/review", { method: "POST", headers: { origin: "https://experience.example", "sec-fetch-site": "same-origin", "content-type": "application/json" }, body: JSON.stringify(body) });

beforeEach(() => { vi.clearAllMocks(); mocks.enabled.mockReturnValue(true); mocks.allowed.mockReturnValue(true); mocks.review.mockResolvedValue({ ok: true, data: review }); });

describe("anonymous review token exchange BFF", () => {
  it("accepts only a body token and seals it while omitting it from the response", async () => {
    const response = await POST(request({ token }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(review);
    expect(mocks.review).toHaveBeenCalledWith(token);
    expect(mocks.setGrant).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ token, caseId: "case_1" }));
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it("rejects query, wrong schema and cross-site requests before upstream", async () => {
    expect((await POST(new Request(`https://experience.example/host/api/preparations/review?token=${token}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) }))).status).toBe(400);
    expect((await POST(request({ token: "short" }))).status).toBe(400);
    expect((await POST(request({ token, unexpected: true }))).status).toBe(400);
    expect(mocks.clearGrant).toHaveBeenCalledTimes(3);
    mocks.allowed.mockReturnValue(false);
    expect((await POST(request({ token }))).status).toBe(403);
  });

  it("clears an older grant when a new link is expired or unavailable", async () => {
    mocks.review.mockResolvedValue({ ok: false, kind: "not_found" });
    expect((await POST(request({ token }))).status).toBe(404);
    expect(mocks.clearGrant).toHaveBeenCalledOnce();

    mocks.review.mockResolvedValue({ ok: true, data: { ...review, expiresAt: "2020-01-01T00:00:00.000Z" } });
    expect((await POST(request({ token }))).status).toBe(404);
    expect(mocks.clearGrant).toHaveBeenCalledTimes(2);
    expect(mocks.setGrant).not.toHaveBeenCalled();
  });
});
