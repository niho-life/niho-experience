import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ allowed: vi.fn(), load: vi.fn(), put: vi.fn(), remove: vi.fn(), failure: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@niho-experience/api-client/experience-provider-operations-schema", () => ({
  isExperienceProviderOperationPathId: (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value),
  decodeExperienceProviderPutMemberInput: (value: unknown) => value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value as object).length === 1 && (value as { role?: unknown }).role === "COHOST" ? { role: "COHOST" } : null,
}));
vi.mock("@/lib/host/provider-operations-server", () => ({
  providerOperationsMutationAllowed: mocks.allowed,
  loadProviderOperationsClient: mocks.load,
  readProviderOperationsJson: async (request: Request, maxBytes: number) => {
    const text = await request.text(); if (new TextEncoder().encode(text).byteLength > maxBytes) return { ok: false };
    try { return { ok: true, value: JSON.parse(text) as unknown }; } catch { return { ok: false }; }
  },
  providerOperationsJson: (body: unknown, status = 200) => Response.json(body, { status }),
  providerOperationsEmpty: () => new Response(null, { status: 204 }),
  providerOperationsFailure: mocks.failure,
}));

import { DELETE, PUT } from "./route";

const context = { params: Promise.resolve({ providerId: "provider_1", userId: "user_1" }) };
const request = (method: "PUT" | "DELETE", body?: unknown) => new Request("https://experience.example/host/api/provider-operations/provider_1/members/user_1", {
  method, headers: { origin: "https://experience.example", "sec-fetch-site": "same-origin", "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
});

describe("provider cohost mutation BFF", () => {
  beforeEach(() => {
    vi.clearAllMocks(); mocks.allowed.mockReturnValue(true);
    mocks.put.mockResolvedValue({ ok: true, data: { member: { userId: "user_1", displayName: "合成候補", role: "COHOST" } } });
    mocks.remove.mockResolvedValue({ ok: true, data: undefined });
    mocks.load.mockResolvedValue({ ok: true, client: { putCohost: mocks.put, deleteCohost: mocks.remove } });
  });

  it("can grant only COHOST and never owner transfer or arbitrary ACL fields", async () => {
    expect((await PUT(request("PUT", { role: "COHOST" }), context)).status).toBe(200);
    expect(mocks.put).toHaveBeenCalledWith("provider_1", "user_1", { role: "COHOST" });
    for (const body of [{ role: "OWNER" }, { role: "EDITOR" }, { role: "COHOST", providerId: "other" }]) {
      expect((await PUT(request("PUT", body), context)).status).toBe(400);
    }
    expect(mocks.put).toHaveBeenCalledTimes(1);
  });

  it("requires same-origin and an empty body to remove a cohost", async () => {
    mocks.allowed.mockReturnValue(false);
    expect((await DELETE(request("DELETE"), context)).status).toBe(403);
    mocks.allowed.mockReturnValue(true);
    expect((await DELETE(request("DELETE", { refund: true }), context)).status).toBe(400);
    expect((await DELETE(request("DELETE"), context)).status).toBe(204);
    expect(mocks.remove).toHaveBeenCalledWith("provider_1", "user_1");
  });
});
