import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  config: { experiencePublicationsEnabled: true, apiMode: "http", hostConsoleEnabled: true, siteUrl: "https://experience.example" },
  read: vi.fn(),
  usable: vi.fn(),
  providers: vi.fn(),
  client: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: mocks.config }));
vi.mock("@/lib/host/session", () => ({ accessTokenUsable: mocks.usable }));
vi.mock("@/lib/host/providers", () => ({ nihoIdOrNull: (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : null }));
vi.mock("@/lib/host/server", () => ({
  readHostSession: mocks.read,
  loadHostProviders: mocks.providers,
  hostApiClient: mocks.client,
  noStoreJson: (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "private, no-store" } }),
  clearSessionCookie: vi.fn(),
}));

import { publicationHostBoundary } from "./publication-host-boundary";

describe("Experience publication host auth boundary", () => {
  afterEach(() => { vi.unstubAllEnvs(); });
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("EXPERIENCE_HOST_PUBLICATION_API_ENABLED", "true");
    Object.assign(mocks.config, { experiencePublicationsEnabled: true, apiMode: "http", hostConsoleEnabled: true });
    mocks.read.mockResolvedValue({ accessToken: "synthetic-token" });
    mocks.usable.mockReturnValue(true);
    mocks.providers.mockResolvedValue({ status: "ok", providers: [{ id: "provider-synthetic", ownerUserId: "owner-synthetic", memberRole: "OWNER" }] });
    mocks.client.mockReturnValue({
      getAuthMe: async () => ({ ok: true, data: { user: { displayName: "Synthetic owner" }, userIconImage: null } }),
      getExperienceProviderPaymentReadiness: async () => ({ ok: true, data: { ready: true, reason: "READY", paymentReuseConsent: { version: "synthetic-v1" } } }),
    });
  });

  it("does not turn provider.ownerUserId or READY alone into a publication actor", async () => {
    const response = await publicationHostBoundary("provider-synthetic", "OWNER");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: "AUTH_CONTRACT_UNAVAILABLE" } });
    expect(mocks.client).toHaveBeenCalledTimes(1);
  });

  it("rechecks the current OWNER role and refuses an editor's owner mutation", async () => {
    mocks.providers.mockResolvedValue({ status: "ok", providers: [{ id: "provider-synthetic", ownerUserId: "owner-synthetic", memberRole: "EDITOR" }] });
    const response = await publicationHostBoundary("provider-synthetic", "OWNER");
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: { code: "FORBIDDEN" } });
    expect(mocks.client).not.toHaveBeenCalled();
  });
});
