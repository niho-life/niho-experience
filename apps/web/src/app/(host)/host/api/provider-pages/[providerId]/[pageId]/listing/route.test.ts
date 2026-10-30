import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ allowed: vi.fn(), load: vi.fn(), get: vi.fn(), request: vi.fn(), withdraw: vi.fn(), failure: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@niho-experience/api-client/experience-provider-operations-schema", () => ({
  isExperienceProviderOperationPathId: (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value),
}));
vi.mock("@/lib/host/provider-pages-server", () => ({ loadProviderPagesClient: mocks.load, providerPagesFailure: mocks.failure }));
vi.mock("@/lib/host/provider-operations-server", () => ({
  providerOperationsMutationAllowed: mocks.allowed,
  readProviderOperationsJson: async (request: Request, maxBytes: number) => {
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) return { ok: false };
    try { return { ok: true, value: JSON.parse(text) as unknown }; } catch { return { ok: false }; }
  },
  providerOperationsJson: (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "private, no-store", "x-robots-tag": "noindex, nofollow" } }),
}));

import { DELETE, GET, PUT } from "./route";

const context = { params: Promise.resolve({ providerId: "provider_1", pageId: "page_1" }) };
const url = "https://experience.example/host/api/provider-pages/provider_1/page_1/listing";
const request = (method: "PUT" | "DELETE", body?: string) => new Request(url, { method, headers: { origin: "https://experience.example", "sec-fetch-site": "same-origin", "content-type": "application/json" }, body });
const consent = { version: "sample-listing-consent-1", text: "（合成）同意の文言" };

describe("provider page listing BFF", () => {
  beforeEach(() => {
    vi.clearAllMocks(); mocks.allowed.mockReturnValue(true);
    mocks.get.mockResolvedValue({ ok: true, data: { listing: null, consent } });
    mocks.request.mockResolvedValue({ ok: true, data: { listing: { status: "REQUESTED" }, consent } });
    mocks.withdraw.mockResolvedValue({ ok: true, data: { listing: { status: "WITHDRAWN" }, consent } });
    mocks.load.mockResolvedValue({ ok: true, client: { getExperienceProviderPageListing: mocks.get, requestExperienceProviderPageListing: mocks.request, withdrawExperienceProviderPageListing: mocks.withdraw } });
    mocks.failure.mockImplementation((failure: { status: number; reason: string | null }) => Response.json({ error: failure.status === 404 ? "permission_ended" : failure.reason }, { status: failure.status }));
  });

  it("reads the listing and its consent for fixed validated ids only", async () => {
    const response = await GET(new Request(url), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ listing: null, consent });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect((await GET(new Request(`${url}?status=ACTIVE`), context)).status).toBe(404);
    // An editor or a stranger: NIHO's 404 stays a 404.
    mocks.get.mockResolvedValueOnce({ ok: false, kind: "error", status: 404, code: "NOT_FOUND", reason: null, message: "" });
    expect((await GET(new Request(url), context)).status).toBe(404);
  });

  it("requests with the consent version only, from the same origin", async () => {
    mocks.allowed.mockReturnValue(false);
    expect((await PUT(request("PUT", JSON.stringify({ consentVersion: consent.version })), context)).status).toBe(403);
    mocks.allowed.mockReturnValue(true);
    for (const body of ["{}", JSON.stringify({ consentVersion: "" }), JSON.stringify({ consentVersion: "x".repeat(101) }), JSON.stringify({ consentVersion: "v1", status: "ACTIVE" }), "not json", JSON.stringify({ consentVersion: "x".repeat(2000) })]) {
      expect((await PUT(request("PUT", body), context)).status).toBe(400);
    }
    expect(mocks.request).not.toHaveBeenCalled();
    const response = await PUT(request("PUT", JSON.stringify({ consentVersion: consent.version })), context);
    expect(response.status).toBe(200);
    expect(mocks.request).toHaveBeenCalledWith("provider_1", "page_1", { consentVersion: consent.version });
  });

  it("answers NIHO's listing refusals with their reason and status", async () => {
    mocks.request.mockResolvedValueOnce({ ok: false, kind: "error", status: 422, code: "UNPROCESSABLE_ENTITY", reason: "EXPERIENCE_LISTING_CONSENT_OUTDATED", message: "" });
    const outdated = await PUT(request("PUT", JSON.stringify({ consentVersion: "old" })), context);
    expect(outdated.status).toBe(422);
    expect(await outdated.json()).toEqual({ error: "EXPERIENCE_LISTING_CONSENT_OUTDATED" });
  });

  it("withdraws with an empty body only", async () => {
    expect((await DELETE(request("DELETE", "{}"), context)).status).toBe(400);
    mocks.allowed.mockReturnValue(false);
    expect((await DELETE(request("DELETE"), context)).status).toBe(403);
    mocks.allowed.mockReturnValue(true);
    expect(mocks.withdraw).not.toHaveBeenCalled();
    const response = await DELETE(request("DELETE"), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ listing: { status: "WITHDRAWN" } });
    expect(mocks.withdraw).toHaveBeenCalledWith("provider_1", "page_1");
  });
});
