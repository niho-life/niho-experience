import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ allowed: vi.fn(), load: vi.fn(), update: vi.fn(), get: vi.fn(), failure: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@niho-experience/api-client/experience-provider-operations-schema", () => ({
  isExperienceProviderOperationPathId: (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value),
}));
vi.mock("@/lib/host/provider-pages-server", () => ({
  isPageVersion: (value: unknown) => typeof value === "string" && /^2026-\d{2}-\d{2}T/.test(value),
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

import { GET, PUT } from "./route";

const context = { params: Promise.resolve({ providerId: "provider_1", pageId: "page_1" }) };
const url = "https://experience.example/host/api/provider-pages/provider_1/page_1/meeting-point";
const request = (body: unknown) => new Request(url, { method: "PUT", headers: { origin: "https://experience.example", "sec-fetch-site": "same-origin", "content-type": "application/json" }, body: JSON.stringify(body) });
const version = "2026-10-27T01:00:00.000Z";
const meetingPoint = { overview: "（合成）駅の近く", address: "（合成）サンプル町", accessNote: "", mapUrl: "", entranceNote: "（合成）門" };

describe("provider page meeting point BFF", () => {
  beforeEach(() => {
    vi.clearAllMocks(); mocks.allowed.mockReturnValue(true);
    mocks.get.mockResolvedValue({ ok: true, data: { mode: "INHERIT", meetingPoint } });
    mocks.update.mockResolvedValue({ ok: true, data: { mode: "OVERRIDE", updatedAt: "2026-10-27T02:00:00.000Z", meetingPoint } });
    mocks.load.mockResolvedValue({ ok: true, client: { getExperienceProviderPageMeetingPoint: mocks.get, updateExperienceProviderPageMeetingPoint: mocks.update } });
    mocks.failure.mockImplementation((failure: { status: number; reason: string }) => Response.json({ error: failure.reason }, { status: failure.status }));
  });

  it("reads only fixed validated ids with private no-store headers", async () => {
    const response = await GET(new Request(url), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ mode: "INHERIT", meetingPoint });
    expect(mocks.get).toHaveBeenCalledWith("provider_1", "page_1");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect((await GET(new Request(`${url}?raw=1`), context)).status).toBe(404);
    expect((await GET(new Request(url), { params: Promise.resolve({ providerId: "../admin", pageId: "page_1" }) })).status).toBe(404);
    expect(mocks.get).toHaveBeenCalledTimes(1);
  });

  it("requires same-origin and the contract's body with a mandatory page version", async () => {
    mocks.allowed.mockReturnValue(false);
    expect((await PUT(request({ mode: "INHERIT", expectedUpdatedAt: version }), context)).status).toBe(403);
    mocks.allowed.mockReturnValue(true);
    for (const body of [
      { mode: "INHERIT" },
      { mode: "INHERIT", expectedUpdatedAt: "2026-10-27" },
      { mode: "INHERIT", expectedUpdatedAt: "1999-10-27T01:00:00.000Z" },
      { mode: "OVERRIDE", expectedUpdatedAt: version },
      { mode: "OVERRIDE", meetingPoint: { ...meetingPoint, mapUrl: "http://maps.example.test" }, expectedUpdatedAt: version },
      { mode: "OVERRIDE", meetingPoint: { ...meetingPoint, phone: "hidden" }, expectedUpdatedAt: version },
      { mode: "OVERRIDE", meetingPoint, expectedUpdatedAt: version, force: true },
    ]) expect((await PUT(request(body), context)).status).toBe(400);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("forwards OVERRIDE and INHERIT as validated and answers NIHO's conflict as it is", async () => {
    const override = { mode: "OVERRIDE", meetingPoint, expectedUpdatedAt: version };
    const response = await PUT(request(override), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ updatedAt: "2026-10-27T02:00:00.000Z" });
    expect(mocks.update).toHaveBeenCalledWith("provider_1", "page_1", override);
    mocks.update.mockResolvedValueOnce({ ok: false, kind: "error", status: 409, code: "CONFLICT", reason: "PROVIDER_PAGE_CONFLICT", message: "" });
    const conflict = await PUT(request({ mode: "INHERIT", expectedUpdatedAt: version }), context);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: "PROVIDER_PAGE_CONFLICT" });
    expect(mocks.update).toHaveBeenLastCalledWith("provider_1", "page_1", { mode: "INHERIT", expectedUpdatedAt: version });
  });
});
