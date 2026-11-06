import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  config: { experienceHostPublicationApiEnabled: true, experiencePublicationConsentVersion: "listing-v1", experiencePayoutAccountConsentVersion: "payout-v1", siteUrl: "https://experience.example.test" },
  read: vi.fn(),
  usable: vi.fn(),
  selectedClient: vi.fn(),
  getIdentity: vi.fn(),
  getConnect: vi.fn(),
  ownerProfile: vi.fn(),
  ensureOwner: vi.fn(),
  hostAccountProfile: vi.fn(),
  refreshReadiness: vi.fn(),
  currentConsent: vi.fn(),
  retrieve: vi.fn(),
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
    currentHostAccountSellerProfile: mocks.hostAccountProfile,
    refreshReadiness: mocks.refreshReadiness,
  }),
  payoutAccountConsents: () => ({ current: mocks.currentConsent }),
}));
vi.mock("@niho-experience/experience-payments", () => ({ retrieveConnectedAccount: mocks.retrieve }));

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
    Object.assign(mocks.config, { experienceHostPublicationApiEnabled: true, experiencePublicationConsentVersion: "listing-v1", experiencePayoutAccountConsentVersion: "payout-v1", siteUrl: "https://experience.example.test" });
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

  describe("with an Experience host account (ADR 0003 slice 3)", () => {
    const hostAccountId = `hst_${"c".repeat(32)}`;
    const sellerRef = `sel_${"d".repeat(32)}`;
    const hostProfile = { ...profile, legacyProviderId: null, sellerNihoAccountRef: sellerRef };
    const summary = { idLast4: "5678", country: "JP", defaultCurrency: "jpy", chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true };
    const consent = { stripeConnectAccountRef: profile.stripeConnectAccountRef, consentVersion: "payout-v1", consentedAtUtc: "2026-11-07T01:00:00.000Z", consentedByHostAccountId: hostAccountId };

    beforeEach(() => {
      vi.stubEnv("EXPERIENCE_STRIPE_PLATFORM_SECRET_KEY", "sk_test_synthetic");
      mocks.read.mockResolvedValue({ kind: "experience", hostAccountId, sessionRef: "0f8fad5b-d9cb-469f-a165-70867728950e" });
      mocks.hostAccountProfile.mockResolvedValue({ kind: "ready", profile: hostProfile, hostAccountActive: true });
      mocks.retrieve.mockResolvedValue({ kind: "ready", account: summary });
      mocks.currentConsent.mockResolvedValue(consent);
      mocks.refreshReadiness.mockResolvedValue({});
    });

    afterEach(() => {
      // NIHO is never called in this mode, whatever the outcome.
      expect(mocks.selectedClient).not.toHaveBeenCalled();
      expect(mocks.getIdentity).not.toHaveBeenCalled();
      expect(mocks.getConnect).not.toHaveBeenCalled();
      expect(mocks.ownerProfile).not.toHaveBeenCalled();
      expect(mocks.ensureOwner).not.toHaveBeenCalled();
      expect(mocks.clear).not.toHaveBeenCalled();
    });

    it("takes the seller from the host account's OWNER profile, readiness from Stripe and the consent from Experience", async () => {
      const result = await publicationHostBoundary("OWNER");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(mocks.hostAccountProfile).toHaveBeenCalledWith(hostAccountId);
      expect(mocks.retrieve).toHaveBeenCalledWith({ accountId: profile.stripeConnectAccountRef, platformStripeKey: "sk_test_synthetic" });
      expect(mocks.currentConsent).toHaveBeenCalledWith({ providerId: profile.providerId, nihoUserId: hostAccountId });
      expect(result.value.actor).toEqual({ providerId: profile.providerId, nihoUserId: hostAccountId });
      expect(result.value.provider).toEqual(hostProfile);
      const { observedAtUtc, validUntilUtc, ...rest } = result.value.readiness;
      expect(rest).toEqual({
        accountUsable: true,
        connectReady: true,
        paymentReuseConsentAccepted: true,
        paymentReuseConsentVersion: "payout-v1",
        paymentReuseConsentedAtUtc: "2026-11-07T01:00:00.000Z",
        sellerDisplayReady: true,
        sellerNihoAccountRef: sellerRef,
        stripeConnectAccountRef: profile.stripeConnectAccountRef,
        sellerDisplayName: profile.sellerDisplayName,
        requiredConsentVersion: "listing-v1",
      });
      expect(Date.parse(validUntilUtc) - Date.parse(observedAtUtc)).toBe(5 * 60 * 1000);
      expect(mocks.refreshReadiness).not.toHaveBeenCalled();
    });

    it("keeps an account Stripe shows not ready, or not to this platform, closed (CONNECT_NOT_READY at publication)", async () => {
      for (const check of [
        { kind: "not_ready", account: { ...summary, payoutsEnabled: false }, problems: ["PAYOUTS_DISABLED"] },
        { kind: "not_ready", account: { ...summary, country: "US", defaultCurrency: "usd" }, problems: ["NOT_JAPAN", "NOT_JPY"] },
        { kind: "unreachable" },
      ]) {
        mocks.retrieve.mockResolvedValueOnce(check);
        const result = await publicationHostBoundary("OWNER");
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.value.readiness).toMatchObject({ connectReady: false, paymentReuseConsentAccepted: true, stripeConnectAccountRef: profile.stripeConnectAccountRef });
      }
    });

    it("fails closed when Stripe or the consent cannot be read, recording a closed snapshot first", async () => {
      for (const failing of [() => mocks.retrieve.mockRejectedValueOnce(new Error("stripe down")), () => mocks.currentConsent.mockRejectedValueOnce(new Error("db down"))]) {
        mocks.refreshReadiness.mockClear();
        failing();
        const result = await publicationHostBoundary("READ");
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.response.status).toBe(502);
          expect(await result.response.json()).toEqual({ error: { code: "READINESS_UNAVAILABLE" } });
        }
        expect(mocks.refreshReadiness).toHaveBeenCalledOnce();
        expect(mocks.refreshReadiness.mock.calls[0]![0]).toEqual({ providerId: profile.providerId, nihoUserId: hostAccountId });
        expect(mocks.refreshReadiness.mock.calls[0]![1]).toMatchObject({ connectReady: false, paymentReuseConsentAccepted: false, paymentReuseConsentVersion: null, paymentReuseConsentedAtUtc: null });
      }
      // A failing snapshot write does not open anything either.
      mocks.retrieve.mockRejectedValueOnce(new Error("stripe down"));
      mocks.refreshReadiness.mockRejectedValueOnce(new Error("db down"));
      const result = await publicationHostBoundary("OWNER");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.response.status).toBe(502);
    });

    it("accepts the consent only at the configured version and for the profile's account", async () => {
      for (const current of [
        { ...consent, consentVersion: "payout-v0" },
        { ...consent, stripeConnectAccountRef: "acct_another12345678" },
        null,
      ]) {
        mocks.currentConsent.mockResolvedValueOnce(current);
        const result = await publicationHostBoundary("OWNER");
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.value.readiness).toMatchObject({ connectReady: true, paymentReuseConsentAccepted: false, paymentReuseConsentVersion: null, paymentReuseConsentedAtUtc: null });
      }
      mocks.config.experiencePayoutAccountConsentVersion = "";
      const result = await publicationHostBoundary("OWNER");
      if (result.ok) expect(result.value.readiness.paymentReuseConsentAccepted).toBe(false);
    });

    it("marks a suspended account unusable and refuses without a resolvable seller, the store or the Stripe key", async () => {
      mocks.hostAccountProfile.mockResolvedValueOnce({ kind: "ready", profile: hostProfile, hostAccountActive: false });
      const suspended = await publicationHostBoundary("OWNER");
      if (suspended.ok) expect(suspended.value.readiness.accountUsable).toBe(false);
      for (const [resolved, status, code] of [
        [{ kind: "setup-required", providerId: profile.providerId }, 409, "SELLER_SETUP_REQUIRED"],
        [{ kind: "ambiguous" }, 409, "SELLER_PROFILE_AMBIGUOUS"],
        [{ kind: "none" }, 403, "FORBIDDEN"],
      ] as const) {
        for (const operation of ["READ", "EDIT", "OWNER"] as const) {
          mocks.hostAccountProfile.mockResolvedValueOnce(resolved);
          const result = await publicationHostBoundary(operation);
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.response.status).toBe(status);
            expect(await result.response.json()).toEqual({ error: { code } });
          }
        }
      }
      mocks.hostAccountProfile.mockRejectedValueOnce(new Error("db down"));
      const failed = await publicationHostBoundary("OWNER");
      if (!failed.ok) expect(await failed.response.json()).toEqual({ error: { code: "READINESS_UNAVAILABLE" } });
      vi.stubEnv("EXPERIENCE_STRIPE_PLATFORM_SECRET_KEY", "");
      const keyless = await publicationHostBoundary("OWNER");
      expect(keyless.ok).toBe(false);
      if (!keyless.ok) expect(await keyless.response.json()).toEqual({ error: { code: "READINESS_UNAVAILABLE" } });
      expect(mocks.retrieve).toHaveBeenCalledTimes(1);
    });
  });
});
