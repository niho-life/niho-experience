import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  config: { experienceHostPublicationApiEnabled: true, experiencePublicationConsentVersion: "listing-v1", siteUrl: "https://experience.example.test" },
  read: vi.fn(),
  usable: vi.fn(),
  selectedClient: vi.fn(),
  getIdentity: vi.fn(),
  getConnect: vi.fn(),
  ownerProfile: vi.fn(),
  ensureOwner: vi.fn(),
  clear: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: mocks.config }));
vi.mock("@/lib/host/session", () => ({ accessTokenUsable: mocks.usable }));
vi.mock("@/lib/host/server", () => ({
  readHostSession: mocks.read,
  selectedHostApiClient: mocks.selectedClient,
  noStoreJson: (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "private, no-store" } }),
  clearSessionCookie: mocks.clear,
}));
vi.mock("@/lib/experience/store-server", () => ({
  experiencePublicationRepository: () => ({
    currentOwnerSellerProfile: mocks.ownerProfile,
    ensureMappedOwnerMembership: mocks.ensureOwner,
  }),
}));

import { publicationHostBoundary } from "./publication-host-boundary";

const profile = {
  providerId: "experience-provider-synthetic",
  legacyProviderId: "niho-legacy-provider-synthetic",
  providerDisplayName: "Synthetic host",
  sellerNihoAccountRef: "niho-user-synthetic",
  stripeConnectAccountRef: "acct_synthetic12345678",
  sellerDisplayName: "Synthetic legal seller",
};
const identity = { ok: true, data: { nihoUserId: "niho-user-synthetic", accountStatus: "ACTIVE" } };
const connect = {
  ok: true,
  data: {
    legacyProviderId: profile.legacyProviderId,
    stripeAccountId: profile.stripeConnectAccountRef,
    readiness: { ready: true, reason: "READY" },
    paymentReuseConsent: { accepted: true, version: "reuse-v3", consentedAt: "2026-11-03T12:00:00.000Z" },
  },
};

describe("Experience publication NIHO contract v1 boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(mocks.config, { experienceHostPublicationApiEnabled: true, experiencePublicationConsentVersion: "listing-v1", siteUrl: "https://experience.example.test" });
    mocks.read.mockResolvedValue({ accessToken: "synthetic-session-token" });
    mocks.usable.mockReturnValue(true);
    mocks.selectedClient.mockResolvedValue({ getIdentity: mocks.getIdentity, getLegacyConnectAccount: mocks.getConnect });
    mocks.getIdentity.mockResolvedValue(identity);
    mocks.getConnect.mockResolvedValue(connect);
    mocks.ownerProfile.mockResolvedValue({ kind: "ready", profile });
    mocks.ensureOwner.mockResolvedValue({ kind: "no-mapping" });
  });

  afterEach(() => vi.unstubAllEnvs());

  it("resolves current NIHO identity, Experience OWNER, and the explicitly mapped Connect account", async () => {
    const result = await publicationHostBoundary("OWNER");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(mocks.ownerProfile).toHaveBeenCalledWith("niho-user-synthetic");
    expect(mocks.getConnect).toHaveBeenCalledWith("niho-legacy-provider-synthetic");
    expect(result.value.actor).toEqual({ providerId: "experience-provider-synthetic", nihoUserId: "niho-user-synthetic" });
    expect(result.value.readiness).toMatchObject({
      accountUsable: true,
      connectReady: true,
      paymentReuseConsentAccepted: true,
      paymentReuseConsentVersion: "reuse-v3",
      paymentReuseConsentedAtUtc: "2026-11-03T12:00:00.000Z",
      sellerNihoAccountRef: "niho-user-synthetic",
      stripeConnectAccountRef: "acct_synthetic12345678",
      sellerDisplayName: "Synthetic legal seller",
      requiredConsentVersion: "listing-v1",
    });
  });

  it("never substitutes the seller account reference for the current identity", async () => {
    mocks.ownerProfile.mockResolvedValue({ kind: "ready", profile: { ...profile, sellerNihoAccountRef: "some-other-niho-user" } });
    const result = await publicationHostBoundary("OWNER");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
      expect(await result.response.json()).toEqual({ error: { code: "SELLER_IDENTITY_MISMATCH" } });
    }
    expect(mocks.getConnect).not.toHaveBeenCalled();
  });

  it("refuses ambiguous or missing Experience seller setup before reading Connect", async () => {
    for (const [resolved, expected] of [
      [{ kind: "ambiguous" }, "SELLER_PROFILE_AMBIGUOUS"],
      [{ kind: "setup-required" }, "SELLER_SETUP_REQUIRED"],
      [{ kind: "none" }, "FORBIDDEN"],
    ] as const) {
      mocks.ownerProfile.mockResolvedValueOnce(resolved);
      const result = await publicationHostBoundary("OWNER");
      expect(result.ok).toBe(false);
      if (!result.ok) expect((await result.response.json()).error.code).toBe(expected);
    }
    expect(mocks.getConnect).not.toHaveBeenCalled();
  });

  it("binds first-login OWNER only from a pre-provisioned mapping matching the current NIHO identity", async () => {
    mocks.ownerProfile.mockResolvedValueOnce({ kind: "none" }).mockResolvedValueOnce({ kind: "ready", profile });
    mocks.ensureOwner.mockResolvedValue({ kind: "linked" });
    const result = await publicationHostBoundary("OWNER");
    expect(result.ok).toBe(true);
    expect(mocks.ensureOwner).toHaveBeenCalledOnce();
    expect(mocks.ensureOwner).toHaveBeenCalledWith("niho-user-synthetic");
    expect(mocks.ownerProfile).toHaveBeenNthCalledWith(2, "niho-user-synthetic");
    expect(mocks.getConnect).toHaveBeenCalledWith(profile.legacyProviderId);
  });

  it("keeps the expected account in the readiness snapshot but blocks a mismatched Connect projection", async () => {
    mocks.getConnect.mockResolvedValue({ ...connect, data: { ...connect.data, stripeAccountId: "acct_wrong_account123" } });
    const result = await publicationHostBoundary("OWNER");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.readiness).toMatchObject({
      connectReady: false,
      stripeConnectAccountRef: profile.stripeConnectAccountRef,
    });
  });

  it("clears an ended NIHO connection", async () => {
    mocks.getIdentity.mockResolvedValue({ ok: false, kind: "error", status: 401 });
    const result = await publicationHostBoundary("OWNER");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
    expect(mocks.clear).toHaveBeenCalledTimes(1);
    expect(mocks.getConnect).not.toHaveBeenCalled();
  });
});
