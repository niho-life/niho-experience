import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  boundary: vi.fn(),
  mutationAllowed: vi.fn(),
  repository: { getForOwner: vi.fn(), save: vi.fn(), withdraw: vi.fn() },
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/host/server", () => ({
  noStoreJson: (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-robots-tag": "noindex, nofollow" } }),
}));
vi.mock("./publication-host-boundary", () => ({
  publicationHostBoundary: mocks.boundary,
  publicationHostMutationAllowed: mocks.mutationAllowed,
}));
vi.mock("./store-server", () => ({ providerSellerDisclosureRepository: () => mocks.repository }));

import { deleteSellerDisclosure, getSellerDisclosure, putSellerDisclosure } from "./seller-disclosure-http";

const actor = { providerId: "provider-private", nihoUserId: "user-private" };
const native = {
  method: "NATIVE" as const, sellerKind: "PERSON" as const, sellerDisplayName: "Synthetic Legal Seller", representativeName: null,
  publicAddress: "Synthetic public address", publicPhone: "046-000-0000", publicEmail: "public@example.test",
  consentVersion: "seller-public-disclosure-v1", accepted: true as const,
};
const state = {
  version: 1, ...native, accepted: undefined, externalUrl: null, consentedAtUtc: "2026-11-05T00:00:00.000Z", withdrawnAtUtc: null,
};

function request(method: string, body?: unknown) {
  return new Request("https://experience.example.test/host/api/seller", {
    method, headers: body === undefined ? undefined : { "content-type": "application/json", origin: "https://experience.example.test", "sec-fetch-site": "same-origin" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("host seller disclosure HTTP boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.boundary.mockResolvedValue({ ok: true, value: { actor } });
    mocks.mutationAllowed.mockReturnValue(true);
    mocks.repository.getForOwner.mockResolvedValue({ sellerDisplayName: "Synthetic Legal Seller", disclosure: null });
    mocks.repository.save.mockResolvedValue(state);
    mocks.repository.withdraw.mockResolvedValue({ ...state, version: 2, method: "WITHDRAWN", publicAddress: null, publicPhone: null, publicEmail: null, withdrawnAtUtc: "2026-11-05T01:00:00.000Z" });
  });

  it("returns only the public-input owner DTO with private no-store headers", async () => {
    const response = await getSellerDisclosure(request("GET"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = await response.json();
    expect(body).toEqual({ seller: { sellerDisplayName: "Synthetic Legal Seller", disclosure: null }, consentVersion: "seller-public-disclosure-v1" });
    expect(JSON.stringify(body)).not.toMatch(/provider-private|user-private|stripe|niho/i);
  });

  it("accepts one exact native command and rejects unknown JSON fields", async () => {
    const commandId = "11111111-1111-4111-8111-111111111111";
    const response = await putSellerDisclosure(request("PUT", { commandId, expectedVersion: null, disclosure: native }));
    expect(response.status).toBe(200);
    expect(mocks.repository.save).toHaveBeenCalledWith(actor, { commandId, expectedVersion: null, disclosure: native });

    const rejected = await putSellerDisclosure(request("PUT", { commandId, expectedVersion: null, disclosure: native, providerId: "provider-private" }));
    expect(rejected.status).toBe(400);
    expect(mocks.repository.save).toHaveBeenCalledTimes(1);
  });

  it("requires same-origin writes and passes withdrawal through current OWNER resolution", async () => {
    mocks.mutationAllowed.mockReturnValueOnce(false);
    expect((await deleteSellerDisclosure(request("DELETE", { commandId: "22222222-2222-4222-8222-222222222222", expectedVersion: 1 }))).status).toBe(403);
    mocks.mutationAllowed.mockReturnValue(true);
    const commandId = "22222222-2222-4222-8222-222222222222";
    expect((await deleteSellerDisclosure(request("DELETE", { commandId, expectedVersion: 1 }))).status).toBe(200);
    expect(mocks.repository.withdraw).toHaveBeenCalledWith(actor, { commandId, expectedVersion: 1 });
  });

  it("does not call the Store after the current OWNER boundary fails", async () => {
    mocks.boundary.mockResolvedValue({ ok: false, response: Response.json({ error: { code: "FORBIDDEN" } }, { status: 403 }) });
    expect((await getSellerDisclosure(request("GET"))).status).toBe(403);
    expect(mocks.repository.getForOwner).not.toHaveBeenCalled();
  });
});
