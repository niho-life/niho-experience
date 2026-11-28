import { beforeEach, describe, expect, it, vi } from "vitest";
import { StoreConflictError } from "@niho-experience/experience-store";

/* 代理受領で売る route (#725): flag, same origin, OWNER, 30 minutes, the configured consent version, the 409s and a repeated command. The store is stubbed. */
const mocks = vi.hoisted(() => ({
  config: {
    hostAgentSalesEnabled: true, hostAccountsEnabled: true, experienceHostPublicationApiEnabled: true, siteUrl: "https://experience.example",
    hostAgentSalesAgreementVersion: "agent-sales-v1", hostAgentReceiverName: "Synthetic NIHO Receiver KK", hostAgentPayoutDelayDays: 3,
  },
  session: null as null | { kind: "experience"; hostAccountId: string; authenticatedAtUtc: string },
  recent: true,
  mutationAllowed: true,
  boundary: vi.fn(),
  publications: { providerHasSellerProfile: vi.fn(), getProduct: vi.fn() },
  disclosures: { getForOwner: vi.fn() },
  agentSales: { choose: vi.fn() },
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ get config() { return mocks.config; } }));
vi.mock("@/lib/host/server", () => ({
  readHostSession: async () => mocks.session,
  noStoreJson: (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "private, no-store" } }),
}));
vi.mock("@/lib/host/session", () => ({ recentlyAuthenticated: () => mocks.recent }));
vi.mock("@/lib/host/niho-identity-server", () => ({ reauthenticationHref: async () => "/host/auth/niho-reauth?next=back" }));
vi.mock("./publication-host-boundary", () => ({ publicationHostBoundary: mocks.boundary, publicationHostMutationAllowed: () => mocks.mutationAllowed }));
vi.mock("./provider-context", () => ({
  requestedProviderId: (request: Request) => ({ ok: true, providerId: new URL(request.url).searchParams.get("providerId") }),
}));
vi.mock("./store-server", () => ({
  experiencePublicationRepository: () => mocks.publications,
  providerSellerDisclosureRepository: () => mocks.disclosures,
  providerAgentSales: () => mocks.agentSales,
}));

import { POST } from "@/app/(host)/host/api/products/[productId]/agent-sales/route";

const HOST = `hst_${"a".repeat(32)}`;
const actor = { providerId: "provider-a", nihoUserId: HOST };
const COMMAND = "11111111-1111-4111-8111-111111111111";
const body = (over: Record<string, unknown> = {}) => ({ commandId: COMMAND, expectedStateVersion: null, agreementVersion: "agent-sales-v1", accepted: true, ...over });
const context = { params: Promise.resolve({ productId: "product-1" }) };
const call = (payload: unknown = body(), query = "?providerId=provider-a") => POST(new Request(`https://experience.example/host/api/products/product-1/agent-sales${query}`, {
  method: "POST", headers: { "content-type": "application/json", origin: "https://experience.example", "sec-fetch-site": "same-origin" },
  body: JSON.stringify(payload),
}), context);
const code = async (response: Response) => ((await response.json()) as { error?: { code?: string } }).error?.code;

const state = {
  current: { revision: 1, plan: "SUPPORTED_15", feeBasisPoints: 1500, agreementVersion: "agent-sales-v1", chargeMode: "PLATFORM", sellerParty: "PROVIDER" },
  phase: "ACTIVE", pending: null, transitionCommandId: null, version: 1,
};

beforeEach(() => {
  mocks.config = { ...mocks.config, hostAgentSalesEnabled: true, hostAccountsEnabled: true, experienceHostPublicationApiEnabled: true };
  mocks.session = { kind: "experience", hostAccountId: HOST, authenticatedAtUtc: new Date().toISOString() };
  mocks.recent = true;
  mocks.mutationAllowed = true;
  vi.stubEnv("EXPERIENCE_MANAGED_PLATFORM_ACCOUNT_ID", "acct_PlatformSample1");
  mocks.boundary.mockReset().mockResolvedValue({ ok: true, value: { actor, role: "OWNER", provider: null, readiness: null } });
  mocks.publications.providerHasSellerProfile.mockReset().mockResolvedValue(false);
  mocks.publications.getProduct.mockReset().mockResolvedValue({ slug: "sample-walk" });
  mocks.disclosures.getForOwner.mockReset().mockResolvedValue({ sellerDisplayName: "", disclosure: { method: "NATIVE", sellerDisplayName: "Sample Host" } });
  mocks.agentSales.choose.mockReset().mockResolvedValue({ state, sellerRef: `agt_${"b".repeat(32)}`, productVersion: 5, replayed: false });
});

describe("POST /host/api/products/{productId}/agent-sales", () => {
  it("is 404 while the flag is off, and calls nothing", async () => {
    mocks.config.hostAgentSalesEnabled = false;
    const response = await call();
    expect(response.status).toBe(404);
    expect(await code(response)).toBe("NOT_FOUND");
    expect(mocks.boundary).not.toHaveBeenCalled();
    expect(mocks.agentSales.choose).not.toHaveBeenCalled();
  });

  it("refuses a cross-site post, a wrong body, and an unchecked consent", async () => {
    mocks.mutationAllowed = false;
    expect((await call()).status).toBe(403);
    mocks.mutationAllowed = true;
    for (const bad of [{ ...body(), extra: 1 }, body({ commandId: "x" }), body({ expectedStateVersion: 0 }), body({ accepted: "yes" }), "[]"]) {
      expect((await call(bad)).status, JSON.stringify(bad)).toBe(400);
    }
    const unchecked = await call(body({ accepted: false }));
    expect([unchecked.status, await code(unchecked)]).toEqual([422, "CONSENT_REQUIRED"]);
    expect(mocks.agentSales.choose).not.toHaveBeenCalled();
  });

  it("asks a sign-in older than 30 minutes to sign in again, and a missing one to sign in", async () => {
    mocks.recent = false;
    const stale = await call();
    expect(stale.status).toBe(401);
    expect(await stale.json()).toEqual({ error: { code: "REAUTH_REQUIRED", href: "/host/auth/niho-reauth?next=back" } });
    mocks.session = null;
    expect((await call()).status).toBe(401);
    expect(mocks.boundary).not.toHaveBeenCalled();
    expect(mocks.agentSales.choose).not.toHaveBeenCalled();
  });

  it("is the OWNER's: the boundary's refusal is the answer", async () => {
    mocks.boundary.mockResolvedValueOnce({ ok: false, response: Response.json({ error: { code: "FORBIDDEN" } }, { status: 403 }) });
    expect((await call()).status).toBe(403);
    expect(mocks.boundary).toHaveBeenCalledWith("OWNER", { providerId: "provider-a", sales: "none" });
    expect(mocks.agentSales.choose).not.toHaveBeenCalled();
  });

  it("answers 409 for an outdated consent, a seller profile, a missing disclosure and a store conflict", async () => {
    expect(await code(await call(body({ agreementVersion: "agent-sales-v0" })))).toBe("CONSENT_OUTDATED");
    mocks.publications.providerHasSellerProfile.mockResolvedValueOnce(true);
    const exists = await call();
    expect([exists.status, await code(exists)]).toEqual([409, "SELLER_EXISTS"]);
    mocks.disclosures.getForOwner.mockResolvedValueOnce({ sellerDisplayName: "", disclosure: null });
    const missing = await call();
    expect([missing.status, await code(missing)]).toEqual([409, "SELLER_DISCLOSURE_REQUIRED"]);
    mocks.disclosures.getForOwner.mockResolvedValueOnce({ sellerDisplayName: "", disclosure: { method: "WITHDRAWN" } });
    expect(await code(await call())).toBe("SELLER_DISCLOSURE_REQUIRED");
    mocks.agentSales.choose.mockRejectedValueOnce(new StoreConflictError("Sales plan version mismatch."));
    const conflict = await call();
    expect([conflict.status, await code(conflict)]).toEqual([409, "VERSION_CONFLICT"]);
    mocks.agentSales.choose.mockRejectedValueOnce(new StoreConflictError("SELLER_EXISTS"));
    expect(await code(await call())).toBe("SELLER_EXISTS");
    expect(mocks.agentSales.choose).toHaveBeenCalledTimes(2);
  });

  it("chooses with the terms from configuration, never the request, and answers the same for a repeated command", async () => {
    const response = await call();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ salesPlan: { current: { plan: "SUPPORTED_15", chargeMode: "PLATFORM", sellerParty: "PROVIDER" }, version: 1 }, productVersion: 5, replayed: false });
    expect(mocks.agentSales.choose).toHaveBeenCalledWith(actor, "product-1", {
      commandId: COMMAND, expectedStateVersion: null, agreementVersion: "agent-sales-v1", accepted: true, platformAccountId: "acct_PlatformSample1",
      receivingAgentName: "Synthetic NIHO Receiver KK", payoutDelayDays: 3, sellerDisclosureUrl: "https://experience.example/experiences/sample-walk/seller",
    });
    mocks.agentSales.choose.mockResolvedValueOnce({ state, sellerRef: `agt_${"b".repeat(32)}`, productVersion: 5, replayed: true });
    const again = await call();
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ replayed: true, productVersion: 5 });
  });
});
