import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  config: {
    experienceHostPublicationApiEnabled: true,
    experiencePublicationConsentVersion: "listing-v1",
    nihoExperienceHostCommonContractAudience: "https://niho.example.test",
    nihoWebOrigin: "https://niho.example.test",
    siteUrl: "https://experience.example.test",
  },
  read: vi.fn(),
  usable: vi.fn(),
  providers: vi.fn(),
  fetch: vi.fn(),
  clear: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("google-auth-library", () => ({
  GoogleAuth: class {
    async getIdTokenClient() {
      return { getRequestHeaders: async () => ({ authorization: "Bearer synthetic-service-token" }) };
    }
  },
}));
vi.mock("@/lib/config", () => ({ config: mocks.config }));
vi.mock("@/lib/host/session", () => ({ accessTokenUsable: mocks.usable }));
vi.mock("@/lib/host/server", () => ({
  readHostSession: mocks.read,
  loadHostProviders: mocks.providers,
  nihoApiFetch: () => mocks.fetch,
  noStoreJson: (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "private, no-store" } }),
  clearSessionCookie: mocks.clear,
}));

import { publicationHostBoundary } from "./publication-host-boundary";

const identity = { nihoUserId: "niho-user-synthetic", accountStatus: "ACTIVE", addedContractField: true };
const connect = {
  legacyProviderId: "provider-synthetic",
  stripeAccountId: "acct_synthetic_panasonic",
  readiness: { ready: true, reason: "READY" },
  addedContractField: "future-compatible",
};
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "content-type": "application/json" } });

describe("Experience publication NIHO boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(mocks.config, {
      experienceHostPublicationApiEnabled: true,
      experiencePublicationConsentVersion: "listing-v1",
      nihoExperienceHostCommonContractAudience: "https://niho.example.test",
      nihoWebOrigin: "https://niho.example.test",
      siteUrl: "https://experience.example.test",
    });
    mocks.read.mockResolvedValue({ accessToken: "synthetic-session-token" });
    mocks.usable.mockReturnValue(true);
    mocks.providers.mockResolvedValue({ status: "ok", providers: [{ id: "provider-synthetic", displayName: "Panasonic", memberRole: "OWNER" }] });
    mocks.fetch.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      return url.endsWith("/identity") ? json(identity) : json(connect);
    });
  });

  afterEach(() => vi.unstubAllEnvs());

  it("uses the active identity and same-owner Connect account without unrelated Connect fields", async () => {
    const result = await publicationHostBoundary("OWNER");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.actor).toEqual({ providerId: "provider-synthetic", nihoUserId: "niho-user-synthetic" });
    expect(result.value.readiness).toMatchObject({
      accountUsable: true,
      connectReady: true,
      sellerDisplayReady: true,
      sellerNihoAccountRef: "niho-user-synthetic",
      stripeConnectAccountRef: "acct_synthetic_panasonic",
      sellerDisplayName: "Panasonic",
      requiredConsentVersion: "listing-v1",
    });
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    for (const [, init] of mocks.fetch.mock.calls) {
      expect(init.headers).toMatchObject({
        authorization: "Bearer synthetic-session-token",
        "x-niho-experience-service-id-token": "synthetic-service-token",
      });
      expect(init.cache).toBe("no-store");
    }
  });

  it("refuses a current non-OWNER before requesting a seller payout account", async () => {
    mocks.providers.mockResolvedValue({ status: "ok", providers: [{ id: "provider-synthetic", displayName: "Panasonic", memberRole: "EDITOR" }] });
    const result = await publicationHostBoundary("OWNER");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(403);
    expect(await result.response.json()).toEqual({ error: { code: "FORBIDDEN" } });
    expect(mocks.fetch).toHaveBeenCalledTimes(1); // identity only
  });

  it("does not choose between multiple seller profiles or Connect destinations", async () => {
    mocks.providers.mockResolvedValue({ status: "ok", providers: [
      { id: "provider-synthetic", displayName: "Panasonic", memberRole: "OWNER" },
      { id: "provider-other", displayName: "Other seller", memberRole: "OWNER" },
    ] });
    const result = await publicationHostBoundary("OWNER");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(409);
    expect(await result.response.json()).toEqual({ error: { code: "SELLER_PROFILE_AMBIGUOUS" } });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it("fails closed on malformed identity and clears an ended NIHO connection", async () => {
    mocks.fetch.mockResolvedValueOnce(json({ ...identity, accountStatus: "PAUSED" }));
    const malformed = await publicationHostBoundary("OWNER");
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.response.status).toBe(502);

    mocks.fetch.mockResolvedValueOnce(json({ error: "unauthorized" }, 401));
    const ended = await publicationHostBoundary("OWNER");
    expect(ended.ok).toBe(false);
    if (!ended.ok) expect(ended.response.status).toBe(401);
    expect(mocks.clear).toHaveBeenCalledTimes(1);
  });
});
