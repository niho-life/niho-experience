import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  read: vi.fn(), hasOwn: vi.fn(), begin: vi.fn(), finalize: vi.fn(), disclosure: { method: "NATIVE" } as Record<string, unknown> | null,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: { siteUrl: "https://experience.example.test" } }));
vi.mock("@/lib/host/server", () => ({ noStoreJson: (body: unknown, status = 200) => Response.json(body, { status }) }));
vi.mock("@/lib/experience/publication-host-boundary", () => ({
  publicationHostMutationAllowed: () => true,
  publicationHostBoundary: async () => ({
    ok: true, value: {
      actor: { providerId: "provider-synthetic", nihoUserId: "owner-synthetic" },
      provider: { stripeConnectAccountRef: "acct_ConnectedSynthetic1", sellerDisplayName: "Synthetic Seller" },
      readiness: { accountUsable: true, connectReady: true, paymentReuseConsentAccepted: true, stripeConnectAccountRef: "acct_ConnectedSynthetic1" },
    },
  }),
}));
vi.mock("@/lib/experience/store-server", () => ({
  managedExperienceSalesRepository: () => ({ get: mocks.read, hasOwnStripeSeller: mocks.hasOwn, beginOwnerSwitch: mocks.begin, finalizeSwitch: mocks.finalize }),
  experiencePublicationRepository: () => ({ getProduct: async () => ({ slug: "synthetic-experience" }) }),
  providerSellerDisclosureRepository: () => ({ getForOwner: async () => ({ disclosure: mocks.disclosure && { sellerDisplayName: "Synthetic Seller", ...mocks.disclosure } }) }),
  experienceStore: () => ({}),
  guestHoldReleases: () => ({}),
}));

import { GET, POST } from "./route";

const commandId = "123e4567-e89b-42d3-a456-426614174509";
const current = { revision: 1, plan: "MANAGED_20", feeBasisPoints: 2000, agreementVersion: "managed-v1", stripeAccountRef: "acct_PlatformSynthetic1" };
const pending = { revision: 2, plan: "SUPPORTED_15", feeBasisPoints: 1500, agreementVersion: "owner-v1" };
const saved = { current, pending, transitionCommandId: commandId, phase: "RECONCILING", version: 3 };
const active = { current: pending, pending: null, transitionCommandId: null, phase: "ACTIVE", version: 4 };
const context = { params: Promise.resolve({ productId: "product-synthetic" }) };
const endpoint = "https://experience.example.test/host/api/products/product-synthetic/sales-plan";

beforeEach(() => {
  mocks.disclosure = { method: "NATIVE" };
  vi.clearAllMocks();
  vi.stubEnv("EXPERIENCE_MANAGED_SALES_ENABLED", "false");
  vi.stubEnv("EXPERIENCE_OWNER_SALES_PLAN_AGREEMENT_VERSION", "owner-v2");
  mocks.read.mockResolvedValue(saved);
  mocks.hasOwn.mockResolvedValue(false);
  mocks.begin.mockResolvedValue({ state: saved, openCheckouts: [] });
  mocks.finalize.mockResolvedValue(active);
});
afterEach(() => vi.unstubAllEnvs());

describe("OWNER sales plan reconciliation", () => {
  it("restores the saved command and consent after a reload, and resumes that command", async () => {
    const response = await GET(new Request(endpoint), context);
    const snapshot = await response.json();
    expect(snapshot.salesPlan).toMatchObject({ pending, transitionCommandId: commandId, version: 3 });
    expect(JSON.stringify(snapshot)).not.toContain("acct_PlatformSynthetic1");

    const resumed = await POST(new Request(endpoint, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ commandId, expectedVersion: snapshot.salesPlan.version, plan: pending.plan, agreementVersion: pending.agreementVersion }),
    }), context);
    expect(resumed.status).toBe(200);
    expect(mocks.begin).toHaveBeenCalledWith(expect.anything(), "product-synthetic", expect.objectContaining({
      commandId, plan: pending.plan, agreementVersion: pending.agreementVersion,
      sellerDisclosureUrl: "https://experience.example.test/experiences/synthetic-experience/seller",
    }));
    expect(mocks.finalize).toHaveBeenCalledWith(expect.anything(), "product-synthetic", commandId, saved.version);
  });

  it("refuses the switch unless the seller disclosure is a native one (an old EXTERNAL row, or none, is not enough)", async () => {
    for (const disclosure of [{ method: "EXTERNAL", externalUrl: "https://seller.example.test/legal" }, { method: "WITHDRAWN" }, null]) {
      mocks.disclosure = disclosure;
      const response = await POST(new Request(endpoint, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ commandId, expectedVersion: 3, plan: pending.plan, agreementVersion: pending.agreementVersion }),
      }), context);
      expect(response.status).toBeGreaterThanOrEqual(400);
    }
    expect(mocks.begin).not.toHaveBeenCalled();
  });

  const post = (body: Record<string, unknown>) => POST(new Request(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), context);
  const fresh = { commandId: "223e4567-e89b-42d3-a456-426614174509", expectedVersion: 1, plan: "INDEPENDENT_10", agreementVersion: "owner-v2" };

  it("refuses a new switch for a host whose seller is its own Stripe account (3c), and never passes the agent-to-independent permission", async () => {
    vi.stubEnv("EXPERIENCE_MANAGED_SALES_ENABLED", "true");
    mocks.read.mockResolvedValue({ ...active, version: 1 });
    mocks.hasOwn.mockResolvedValue(true);
    for (const plan of ["SUPPORTED_15", "INDEPENDENT_10"]) {
      const response = await post({ ...fresh, plan });
      expect([response.status, (await response.json()).error.code]).toEqual([409, "PLAN_NOT_AVAILABLE"]);
    }
    expect(mocks.begin).not.toHaveBeenCalled();
    // A switch that began is still resumed, and an office-registered seller's switch is as before.
    mocks.read.mockResolvedValue(saved);
    expect((await post({ commandId, expectedVersion: 3, plan: pending.plan, agreementVersion: pending.agreementVersion })).status).toBe(200);
    mocks.read.mockResolvedValue({ ...active, version: 1 });
    mocks.hasOwn.mockResolvedValue(false);
    mocks.begin.mockResolvedValue({ state: saved, openCheckouts: [] });
    expect((await post({ ...fresh, plan: "SUPPORTED_15" })).status).toBe(200);
    expect(mocks.begin.mock.calls.every((call) => call[2].allowAgentToIndependent === undefined)).toBe(true);
  });
});
