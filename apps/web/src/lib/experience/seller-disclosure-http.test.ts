import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  boundary: vi.fn(),
  mutationAllowed: vi.fn(),
  repository: { getForOwner: vi.fn(), save: vi.fn(), withdraw: vi.fn() },
  config: { hostAgentSalesEnabled: false, hostAccountsEnabled: false },
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: mocks.config }));
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
    Object.assign(mocks.config, { hostAgentSalesEnabled: false, hostAccountsEnabled: false });
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

  it("asks for the seller side as before, and with agent sales (#725) only for the OWNER, passing the option to the store", async () => {
    await getSellerDisclosure(request("GET"));
    expect(mocks.boundary).toHaveBeenLastCalledWith("READ", { providerId: null, sales: "seller" });
    expect(mocks.repository.getForOwner).toHaveBeenLastCalledWith(actor);

    Object.assign(mocks.config, { hostAgentSalesEnabled: true, hostAccountsEnabled: true });
    const commandId = "11111111-1111-4111-8111-111111111111";
    await getSellerDisclosure(request("GET"));
    expect(mocks.boundary).toHaveBeenLastCalledWith("READ", { providerId: null, sales: "none" });
    expect(mocks.repository.getForOwner).toHaveBeenLastCalledWith(actor, { agentSales: true });
    expect((await putSellerDisclosure(request("PUT", { commandId, expectedVersion: null, disclosure: native }))).status).toBe(200);
    expect(mocks.repository.save).toHaveBeenLastCalledWith(actor, { commandId, expectedVersion: null, disclosure: native }, { agentSales: true });
    expect((await deleteSellerDisclosure(request("DELETE", { commandId, expectedVersion: 1 }))).status).toBe(200);
    expect(mocks.repository.withdraw).toHaveBeenLastCalledWith(actor, { commandId, expectedVersion: 1 }, { agentSales: true });
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

  it("rejects a new EXTERNAL disclosure with the validation error, while GET still returns an existing EXTERNAL row", async () => {
    const commandId = "11111111-1111-4111-8111-111111111111";
    const external = { method: "EXTERNAL", sellerKind: "PERSON", sellerDisplayName: "Synthetic Legal Seller", externalUrl: "https://seller.example.test/legal", consentVersion: "seller-public-disclosure-v1", accepted: true };
    const rejected = await putSellerDisclosure(request("PUT", { commandId, expectedVersion: 1, disclosure: external }));
    expect(rejected.status).toBe(400);
    expect(mocks.repository.save).not.toHaveBeenCalled();

    const old = { ...state, method: "EXTERNAL", representativeName: null, publicAddress: null, publicPhone: null, publicEmail: null, externalUrl: "https://seller.example.test/legal" };
    mocks.repository.getForOwner.mockResolvedValue({ sellerDisplayName: "Synthetic Legal Seller", disclosure: old });
    const read = await getSellerDisclosure(request("GET"));
    expect(read.status).toBe(200);
    expect((await read.json()).seller.disclosure.method).toBe("EXTERNAL");
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
