import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ allowed: vi.fn(), load: vi.fn(), update: vi.fn(), get: vi.fn(), failure: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@niho-experience/api-client/experience-provider-operations-schema", () => ({
  isExperienceProviderOperationPathId: (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value),
}));
vi.mock("@niho-experience/api-client/host-schema", () => ({
  decodeExperienceProviderPagePatchRequest: (value: unknown) => value && typeof value === "object" && !Array.isArray(value)
    && !Object.keys(value).some((key) => !["title", "content", "offers", "photoObjectKeys", "photoAlts"].includes(key)) ? value : null,
}));
vi.mock("@/lib/host/provider-pages-server", () => ({
  isPageVersion: (value: unknown) => typeof value === "string" && /^2026-/.test(value),
  loadProviderPagesClient: mocks.load,
  providerPagesFailure: mocks.failure,
}));
vi.mock("@/lib/host/provider-operations-server", () => ({
  providerOperationsMutationAllowed: mocks.allowed,
  readProviderOperationsJson: async (request: Request, maxBytes: number) => {
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) return { ok: false };
    try { return { ok: true, value: JSON.parse(text) as unknown }; } catch { return { ok: false }; }
  },
  providerOperationsJson: (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-robots-tag": "noindex, nofollow" } }),
}));

import { GET, PATCH } from "./route";

const context = { params: Promise.resolve({ providerId: "provider_1", pageId: "page_1" }) };
const request = (body: unknown, origin = "https://experience.example") => new Request("https://experience.example/host/api/provider-pages/provider_1/page_1", {
  method: "PATCH", headers: { origin, "sec-fetch-site": "same-origin", "content-type": "application/json" }, body: JSON.stringify(body),
});

describe("provider page detail BFF", () => {
  beforeEach(() => {
    vi.clearAllMocks(); mocks.allowed.mockReturnValue(true);
    mocks.get.mockResolvedValue({ ok: true, data: { id: "page_1" } });
    mocks.update.mockResolvedValue({ ok: true, data: { id: "page_1", updatedAt: "2026-10-27T02:00:00.000Z" } });
    mocks.load.mockResolvedValue({ ok: true, client: { getExperienceProviderPage: mocks.get, updateExperienceProviderPage: mocks.update } });
    mocks.failure.mockImplementation(() => Response.json({ error: "upstream" }, { status: 502 }));
  });

  it("reads only fixed validated ids with private no-store headers", async () => {
    const response = await GET(new Request("https://experience.example/host/api/provider-pages/provider_1/page_1"), context);
    expect(response.status).toBe(200);
    expect(mocks.get).toHaveBeenCalledWith("provider_1", "page_1");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect((await GET(new Request("https://experience.example/host/api/provider-pages/provider_1/page_1?raw=1"), context)).status).toBe(404);
  });

  it("requires same-origin, exact wrapper keys and a mandatory page version", async () => {
    mocks.allowed.mockReturnValue(false);
    expect((await PATCH(request({ expectedUpdatedAt: "2026-10-27T01:00:00.000Z", patch: { title: "合成" } }, "https://evil.example"), context)).status).toBe(403);
    mocks.allowed.mockReturnValue(true);
    for (const body of [
      { patch: { title: "合成" } },
      { expectedUpdatedAt: null, patch: { title: "合成" } },
      { expectedUpdatedAt: "2026-10-27T01:00:00.000Z", patch: { title: "合成" }, force: true },
      { expectedUpdatedAt: "2026-10-27T01:00:00.000Z", patch: { title: "合成", stripeAccountId: "hidden" } },
    ]) expect((await PATCH(request(body), context)).status).toBe(400);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("forwards only a validated patch with the exact optimistic-concurrency version", async () => {
    const body = { expectedUpdatedAt: "2026-10-27T01:00:00.000Z", patch: { title: "合成の更新", content: { lead: "合成" }, photoObjectKeys: [], photoAlts: [], offers: [{ id: "offer_1" }] } };
    const response = await PATCH(request(body), context);
    expect(response.status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith("provider_1", "page_1", body.patch, body.expectedUpdatedAt);
  });
});
