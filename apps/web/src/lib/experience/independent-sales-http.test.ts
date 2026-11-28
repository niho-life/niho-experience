import { beforeEach, describe, expect, it, vi } from "vitest";
import { StoreConflictError } from "@niho-experience/experience-store";

/* 独立 10% で売る route (3c-2, #726): flag, same origin, OWNER, 30 minutes, readiness, the configured consent version, the 409s, a repeated command and the switch from 代理受領. The stores are stubbed. */
const mocks = vi.hoisted(() => ({
  config: {
    hostStandardOnboardingEnabled: true, hostAccountsEnabled: true, experienceHostPublicationApiEnabled: true, siteUrl: "https://experience.example",
    hostIndependentSalesAgreementVersion: "independent-sales-v1",
  },
  session: null as null | { kind: "experience"; hostAccountId: string; authenticatedAtUtc: string },
  recent: true,
  mutationAllowed: true,
  boundary: vi.fn(),
  publications: { getProduct: vi.fn() },
  disclosures: { getForOwner: vi.fn() },
  sellers: { chooseIndependent: vi.fn() },
  managed: { get: vi.fn(), beginOwnerSwitch: vi.fn(), recordCheckoutOutcome: vi.fn(), finalizeSwitch: vi.fn() },
  bookings: { getBooking: vi.fn() },
  releases: { expireGuestHoldForSalesPlanSwitch: vi.fn() },
  expirePlatform: vi.fn(),
  expireDirect: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ get config() { return mocks.config; } }));
vi.mock("@/lib/host/server", () => ({
  readHostSession: async () => mocks.session,
  noStoreJson: (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "private, no-store" } }),
}));
vi.mock("@/lib/host/session", () => ({ recentlyAuthenticated: () => mocks.recent }));
vi.mock("@/lib/host/niho-identity-server", () => ({ reauthenticationHref: async () => "/host/auth/niho-reauth?next=back" }));
vi.mock("@niho-experience/experience-payments", () => ({ expirePlatformCheckout: mocks.expirePlatform, expireDirectCheckout: mocks.expireDirect }));
vi.mock("./publication-host-boundary", () => ({ publicationHostBoundary: mocks.boundary, publicationHostMutationAllowed: () => mocks.mutationAllowed }));
vi.mock("./provider-context", () => ({
  requestedProviderId: (request: Request) => ({ ok: true, providerId: new URL(request.url).searchParams.get("providerId") }),
}));
vi.mock("./store-server", () => ({
  experiencePublicationRepository: () => mocks.publications,
  providerSellerDisclosureRepository: () => mocks.disclosures,
  directSellers: () => mocks.sellers,
  managedExperienceSalesRepository: () => mocks.managed,
  experienceStore: () => mocks.bookings,
  guestHoldReleases: () => mocks.releases,
}));

import { POST } from "@/app/(host)/host/api/products/[productId]/independent-sales/route";

const HOST = `hst_${"a".repeat(32)}`;
const actor = { providerId: "provider-a", nihoUserId: HOST };
const COMMAND = "11111111-1111-4111-8111-111111111111";
const ACCOUNT = "acct_SyntheticDirect0001";
const body = (over: Record<string, unknown> = {}) => ({ commandId: COMMAND, expectedStateVersion: null, agreementVersion: "independent-sales-v1", accepted: true, ...over });
const context = { params: Promise.resolve({ productId: "product-1" }) };
const call = (payload: unknown = body(), query = "?providerId=provider-a") => POST(new Request(`https://experience.example/host/api/products/product-1/independent-sales${query}`, {
  method: "POST", headers: { "content-type": "application/json", origin: "https://experience.example", "sec-fetch-site": "same-origin" },
  body: JSON.stringify(payload),
}), context);
const code = async (response: Response) => ((await response.json()) as { error?: { code?: string } }).error?.code;

const revision = (over: Record<string, unknown> = {}) => ({ revision: 1, plan: "INDEPENDENT_10", feeBasisPoints: 1000, agreementVersion: "independent-sales-v1", chargeMode: "CONNECT_DIRECT", sellerParty: "PROVIDER", ...over });
const state = (current = revision(), over: Record<string, unknown> = {}) => ({ current, phase: "ACTIVE", pending: null, transitionCommandId: null, version: 1, ...over });
const agentState = (over: Record<string, unknown> = {}) => state(revision({ plan: "SUPPORTED_15", feeBasisPoints: 1500, chargeMode: "PLATFORM" }), over);

const readiness = { accountUsable: true, connectReady: true, paymentReuseConsentAccepted: true, stripeConnectAccountRef: ACCOUNT };
const provider = { stripeConnectAccountRef: ACCOUNT, sellerDisplayName: "Sample Host" };

beforeEach(() => {
  mocks.config = { ...mocks.config, hostIndependentSalesAgreementVersion: "independent-sales-v1", hostStandardOnboardingEnabled: true, hostAccountsEnabled: true, experienceHostPublicationApiEnabled: true };
  mocks.session = { kind: "experience", hostAccountId: HOST, authenticatedAtUtc: new Date().toISOString() };
  mocks.recent = true;
  mocks.mutationAllowed = true;
  mocks.boundary.mockReset().mockResolvedValue({ ok: true, value: { actor, role: "OWNER", provider, readiness } });
  mocks.publications.getProduct.mockReset().mockResolvedValue({ slug: "sample-walk" });
  mocks.disclosures.getForOwner.mockReset().mockResolvedValue({ sellerDisplayName: "", disclosure: { method: "NATIVE", sellerDisplayName: "Sample Host" } });
  mocks.sellers.chooseIndependent.mockReset().mockResolvedValue({ state: state(), sellerRef: `sel_${"b".repeat(32)}`, productVersion: 5, replayed: false });
  mocks.managed.get.mockReset().mockResolvedValue(null);
  mocks.managed.beginOwnerSwitch.mockReset();
  mocks.managed.recordCheckoutOutcome.mockReset();
  mocks.managed.finalizeSwitch.mockReset();
  mocks.bookings.getBooking.mockReset();
  mocks.releases.expireGuestHoldForSalesPlanSwitch.mockReset().mockResolvedValue(undefined);
  mocks.expirePlatform.mockReset();
  mocks.expireDirect.mockReset();
});

describe("POST /host/api/products/{productId}/independent-sales", () => {
  it("is 404 while the flag is off, and calls nothing", async () => {
    mocks.config.hostStandardOnboardingEnabled = false;
    const response = await call();
    expect(response.status).toBe(404);
    expect(await code(response)).toBe("NOT_FOUND");
    expect(mocks.sellers.chooseIndependent).not.toHaveBeenCalled();
    expect(mocks.managed.beginOwnerSwitch).not.toHaveBeenCalled();
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
    expect(mocks.sellers.chooseIndependent).not.toHaveBeenCalled();
  });

  it("asks a sign-in older than 30 minutes to sign in again, and a missing one to sign in", async () => {
    mocks.recent = false;
    const stale = await call();
    expect(stale.status).toBe(401);
    expect(await stale.json()).toEqual({ error: { code: "REAUTH_REQUIRED", href: "/host/auth/niho-reauth?next=back" } });
    mocks.session = null;
    expect((await call()).status).toBe(401);
    expect(mocks.boundary).not.toHaveBeenCalled();
  });

  it("is the OWNER's, with the readiness of a sale: the boundary's refusal is the answer", async () => {
    mocks.boundary.mockResolvedValueOnce({ ok: false, response: Response.json({ error: { code: "FORBIDDEN" } }, { status: 403 }) });
    expect((await call()).status).toBe(403);
    expect(mocks.boundary).toHaveBeenCalledWith("OWNER", { providerId: "provider-a" });
    expect(mocks.sellers.chooseIndependent).not.toHaveBeenCalled();
  });

  it("answers CONNECT_NOT_READY unless the account is usable, connected, consented and the seller's own", async () => {
    for (const over of [{ accountUsable: false }, { connectReady: false }, { paymentReuseConsentAccepted: false }, { stripeConnectAccountRef: "acct_SyntheticOther0002" }]) {
      mocks.boundary.mockResolvedValueOnce({ ok: true, value: { actor, role: "OWNER", provider, readiness: { ...readiness, ...over } } });
      const response = await call();
      expect([response.status, await code(response)], JSON.stringify(over)).toEqual([409, "CONNECT_NOT_READY"]);
    }
    expect(mocks.sellers.chooseIndependent).not.toHaveBeenCalled();
  });

  it("answers 409 for an outdated consent, a missing or other-named disclosure, and a store conflict", async () => {
    expect(await code(await call(body({ agreementVersion: "independent-sales-v0" })))).toBe("CONSENT_OUTDATED");
    mocks.disclosures.getForOwner.mockResolvedValueOnce({ sellerDisplayName: "", disclosure: null });
    const missing = await call();
    expect([missing.status, await code(missing)]).toEqual([409, "SELLER_DISCLOSURE_REQUIRED"]);
    mocks.disclosures.getForOwner.mockResolvedValueOnce({ sellerDisplayName: "", disclosure: { method: "NATIVE", sellerDisplayName: "Other Name" } });
    expect(await code(await call())).toBe("SELLER_DISCLOSURE_REQUIRED");
    mocks.sellers.chooseIndependent.mockRejectedValueOnce(new StoreConflictError("VERSION_CONFLICT"));
    const conflict = await call();
    expect([conflict.status, await code(conflict)]).toEqual([409, "VERSION_CONFLICT"]);
    for (const message of ["DIRECT_SELLER_REQUIRED", "PAYOUT_CONSENT_REQUIRED", "SELLER_MISMATCH", "SELLER_DISCLOSURE_REQUIRED"]) {
      mocks.sellers.chooseIndependent.mockRejectedValueOnce(new StoreConflictError(message));
      expect(await code(await call()), message).toBe(message);
    }
    expect(mocks.sellers.chooseIndependent).toHaveBeenCalledTimes(5);
  });

  it("chooses for a product with no plan, with the URL from configuration, and answers the same for a repeated command", async () => {
    const response = await call();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ salesPlan: { current: { plan: "INDEPENDENT_10", chargeMode: "CONNECT_DIRECT" }, version: 1 }, productVersion: 5, replayed: false, switched: false });
    expect(mocks.sellers.chooseIndependent).toHaveBeenCalledWith(actor, "product-1", expect.objectContaining({
      commandId: COMMAND, expectedStateVersion: null, agreementVersion: "independent-sales-v1",
      sellerDisclosureUrl: "https://experience.example/experiences/sample-walk/seller",
    }));
    mocks.sellers.chooseIndependent.mockResolvedValueOnce({ state: state(), sellerRef: `sel_${"b".repeat(32)}`, productVersion: 5, replayed: true });
    // The product is 独立 10% now: the repeated command is read by the store, not switched.
    mocks.managed.get.mockResolvedValueOnce(state());
    const again = await call(body({ expectedStateVersion: 1 }));
    expect(await again.json()).toMatchObject({ replayed: true, productVersion: 5 });
    expect(mocks.managed.beginOwnerSwitch).not.toHaveBeenCalled();
  });

  it("switches a product sold with 代理受領: expires each open Checkout by its snapshot, records it, then finalizes", async () => {
    mocks.managed.get.mockResolvedValue(agentState());
    const open = { publicBookingId: "bk-1", checkoutSessionRef: "cs_test_1" };
    const open2 = { publicBookingId: "bk-2", checkoutSessionRef: "cs_test_2" };
    mocks.managed.beginOwnerSwitch.mockResolvedValue({ state: agentState({ phase: "EXPIRING_OLD_CHECKOUTS", version: 2, transitionCommandId: COMMAND }), openCheckouts: [open, open2] });
    mocks.bookings.getBooking.mockImplementation(async (_actor: unknown, id: string) => ({ id, sellerSnapshot: { chargeMode: id === "bk-1" ? "PLATFORM" : "CONNECT_DIRECT" } }));
    mocks.expirePlatform.mockResolvedValue("expired");
    mocks.expireDirect.mockResolvedValue("paid");
    mocks.managed.recordCheckoutOutcome.mockResolvedValue(agentState({ phase: "RECONCILING", version: 3, transitionCommandId: COMMAND }));
    mocks.managed.finalizeSwitch.mockResolvedValue(state(revision({ revision: 2 }), { version: 4 }));
    const response = await call(body({ expectedStateVersion: 1 }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ salesPlan: { current: { plan: "INDEPENDENT_10", revision: 2 } }, switched: true });
    expect(mocks.managed.beginOwnerSwitch).toHaveBeenCalledWith(actor, "product-1", expect.objectContaining({
      commandId: COMMAND, expectedVersion: 1, plan: "INDEPENDENT_10", agreementVersion: "independent-sales-v1", stripeReady: true, allowAgentToIndependent: true,
      sellerDisclosureUrl: "https://experience.example/experiences/sample-walk/seller",
    }));
    expect(mocks.expirePlatform).toHaveBeenCalledTimes(1);
    expect(mocks.expireDirect).toHaveBeenCalledTimes(1);
    expect(mocks.releases.expireGuestHoldForSalesPlanSwitch).toHaveBeenCalledTimes(1);
    expect(mocks.managed.recordCheckoutOutcome.mock.calls.map((callArgs) => callArgs[4])).toEqual(["EXPIRED", "PAID"]);
    expect(mocks.managed.finalizeSwitch).toHaveBeenCalledWith(actor, "product-1", COMMAND, 3);
    expect(mocks.sellers.chooseIndependent).not.toHaveBeenCalled();
  });

  it("needs the state version it read for a product that has a plan, and maps the switch's refusals", async () => {
    mocks.managed.get.mockResolvedValue(agentState());
    const missing = await call(body({ expectedStateVersion: null }));
    expect([missing.status, await code(missing)]).toEqual([409, "VERSION_CONFLICT"]);
    mocks.managed.beginOwnerSwitch.mockRejectedValueOnce(new StoreConflictError("An agent-sales product cannot switch to a Direct charge."));
    expect(await code(await call(body({ expectedStateVersion: 1 })))).toBe("VERSION_CONFLICT");
    expect(mocks.sellers.chooseIndependent).not.toHaveBeenCalled();
  });

  it("finishes a stopped switch after a 503 or an UNKNOWN Checkout, read again: the same command, with the flag off and a new consent version in the settings", async () => {
    const stopped = state(agentState().current, { phase: "RECONCILING", transitionCommandId: COMMAND, version: 3, pending: revision({ revision: 2 }) });
    mocks.managed.get.mockResolvedValue(stopped);
    mocks.managed.beginOwnerSwitch.mockResolvedValue({ state: stopped, openCheckouts: [{ publicBookingId: "bk-1", checkoutSessionRef: "cs_test_1" }] });
    mocks.bookings.getBooking.mockResolvedValue({ sellerSnapshot: { chargeMode: "PLATFORM" } });
    mocks.expirePlatform.mockResolvedValueOnce("unknown");
    mocks.managed.recordCheckoutOutcome.mockResolvedValue(stopped);
    mocks.managed.finalizeSwitch.mockRejectedValueOnce(new StoreConflictError("Old Checkout Sessions are not reconciled."));
    // First try: the Checkout's state is unknown, so the switch cannot finish.
    expect((await call(body({ expectedStateVersion: 3 }))).status).toBe(409);
    // Read again, with the flag off and another consent version configured: the same command is finished.
    Object.assign(mocks.config, { hostStandardOnboardingEnabled: false, hostIndependentSalesAgreementVersion: "independent-sales-v9" });
    mocks.expirePlatform.mockResolvedValueOnce("expired");
    mocks.managed.finalizeSwitch.mockResolvedValue(state(revision({ revision: 2 }), { version: 4 }));
    const finished = await call(body({ expectedStateVersion: 3 }));
    expect(finished.status).toBe(200);
    expect(await finished.json()).toMatchObject({ switched: true });
    // A new choice (another command, or other terms) is still refused with the flag off, and with the old version once it is on.
    expect(await code(await call(body({ commandId: "33333333-3333-4333-8333-333333333333", expectedStateVersion: 3 })))).toBe("NOT_FOUND");
    expect(await code(await call(body({ agreementVersion: "independent-sales-v0", expectedStateVersion: 3 })))).toBe("NOT_FOUND");
    mocks.config.hostStandardOnboardingEnabled = true;
    expect(await code(await call(body({ commandId: "33333333-3333-4333-8333-333333333333", expectedStateVersion: 3 })))).toBe("CONSENT_OUTDATED");
  });

  it("resumes a switch the same command began (the plan is already pending)", async () => {
    mocks.managed.get.mockResolvedValue(state(revision({ plan: "SUPPORTED_15", chargeMode: "PLATFORM", feeBasisPoints: 1500 }), { phase: "RECONCILING", transitionCommandId: COMMAND, version: 3 }));
    mocks.managed.beginOwnerSwitch.mockResolvedValue({ state: agentState({ phase: "RECONCILING", version: 3, transitionCommandId: COMMAND }), openCheckouts: [] });
    mocks.managed.finalizeSwitch.mockResolvedValue(state(revision({ revision: 2 }), { version: 4 }));
    const response = await call(body({ expectedStateVersion: 3 }));
    expect(await response.json()).toMatchObject({ switched: true });
    expect(mocks.managed.finalizeSwitch).toHaveBeenCalledWith(actor, "product-1", COMMAND, 3);
  });
});
