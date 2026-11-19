import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  config: {
    hostConsoleEnabled: true,
    hostArticleLinksEnabled: true,
    nihoWriterEnabled: false,
    nihoArticleAuthorityOrigin: "https://niho.example.invalid",
    nihoArticleAuthorityAudience: "synthetic-audience",
    nihoArticleLinksAudience: "synthetic-host-links-audience",
  },
  readSession: vi.fn(),
  loadProviders: vi.fn(),
  readNihoUserId: vi.fn(),
  clearSession: vi.fn(),
  getIdTokenClient: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("google-auth-library", () => ({ GoogleAuth: class { getIdTokenClient = mocks.getIdTokenClient; } }));
vi.mock("@/lib/config", () => ({ config: mocks.config }));
vi.mock("@/lib/host/server", () => ({
  readHostSession: mocks.readSession,
  loadHostProvidersFresh: mocks.loadProviders,
  nihoApiFetch: () => fetch,
  clearSessionCookie: mocks.clearSession,
  noStoreJson: (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "private, no-store" } }),
}));
vi.mock("@/lib/experience/store-server", () => ({ hostAccountIdentities: () => ({ readNihoUserId: mocks.readNihoUserId }) }));

import type { NihoHostSession } from "./session";
import { HostArticleLinkClient, ModernHostArticleLinkClient, hostArticleLinkFailure, loadHostGuideLinkContext } from "./guide-link-api-server";

const SESSION = {
  accessToken: "opaque-host-token",
  accessTokenExpiresAt: Date.now() + 3_600_000,
} as NihoHostSession;
const ID = "00000000-0000-4000-8000-000000000042";
const LINK = {
  id: ID, state: "PENDING", providerName: "Synthetic Provider", inviterName: "Synthetic Host", writerName: "Synthetic Writer",
  writerLabel: "記事ライター", expiresAt: "2030-01-04T00:00:00.000Z", acceptedAt: null, createdAt: "2030-01-01T00:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.config.hostConsoleEnabled = true;
  mocks.config.hostArticleLinksEnabled = true;
  mocks.config.nihoWriterEnabled = false;
  mocks.readSession.mockResolvedValue(SESSION);
  mocks.loadProviders.mockResolvedValue({ status: "ok", providers: [{ id: "provider-a", memberRole: "OWNER" }] });
  mocks.readNihoUserId.mockResolvedValue("niho-owner-a");
  mocks.getIdTokenClient.mockResolvedValue({ getRequestHeaders: async () => ({ authorization: "Bearer google-service-token" }) });
});

describe("host article-link context", () => {
  it("uses the current host session without inferring a NIHO actor from provider data", async () => {
    const loaded = await loadHostGuideLinkContext("provider-a");
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.value.client).toBeInstanceOf(HostArticleLinkClient);
      expect(loaded.value).not.toHaveProperty("session");
    }
  });

  it("uses the linked NIHO identity and current OWNER for modern hst sessions without a user bearer", async () => {
    mocks.config.hostArticleLinksEnabled = false;
    mocks.config.nihoWriterEnabled = true;
    mocks.readSession.mockResolvedValue({ kind: "experience", hostAccountId: `hst_${"a".repeat(32)}` });
    const loaded = await loadHostGuideLinkContext("provider-a");
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.value.client).toBeInstanceOf(ModernHostArticleLinkClient);
    expect(mocks.readNihoUserId).toHaveBeenCalledWith({ hostAccountId: `hst_${"a".repeat(32)}` });

    mocks.loadProviders.mockResolvedValueOnce({ status: "ok", providers: [{ id: "provider-a", memberRole: "EDITOR" }] });
    const forbidden = await loadHostGuideLinkContext("provider-a");
    expect(!forbidden.ok && forbidden.response.status).toBe(403);
  });

  it("fails closed while disabled, signed out, expired, or session storage is unavailable", async () => {
    mocks.config.hostArticleLinksEnabled = false;
    expect((await loadHostGuideLinkContext("provider-a")).ok).toBe(false);
    mocks.config.hostArticleLinksEnabled = true;
    mocks.readSession.mockResolvedValueOnce(null);
    const signedOut = await loadHostGuideLinkContext("provider-a");
    expect(!signedOut.ok && signedOut.response.status).toBe(401);
    mocks.readSession.mockResolvedValueOnce({ ...SESSION, accessTokenExpiresAt: 0 });
    const expired = await loadHostGuideLinkContext("provider-a");
    expect(!expired.ok && expired.response.status).toBe(401);
    mocks.readSession.mockRejectedValueOnce(new Error("storage unavailable"));
    const unavailable = await loadHostGuideLinkContext("provider-a");
    expect(!unavailable.ok && unavailable.response.status).toBe(503);
  });
});

describe("HostArticleLinkClient", () => {
  it("mints the host API token for its dedicated audience, not the internal authority audience", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ items: [] })) as unknown as typeof fetch;
    await new HostArticleLinkClient(SESSION, fetchImpl).list("provider-a");
    expect(mocks.getIdTokenClient).toHaveBeenCalledWith("synthetic-host-links-audience");
    expect(mocks.getIdTokenClient).not.toHaveBeenCalledWith("synthetic-audience");
  });

  it("sends both the opaque host access token and the dedicated runtime ID token to fixed NIHO paths", async () => {
    const calls: { path: string; method: string; body: unknown }[] = [];
    const fetchImpl = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer opaque-host-token");
      expect(headers.get("x-niho-experience-service-id-token")).toBe("google-service-token");
      calls.push({ path: url.pathname, method: init?.method ?? "GET", body: init?.body });
      if ((init?.method ?? "GET") === "GET") return Response.json({ items: [LINK] });
      if (url.pathname.endsWith("/revoke")) return Response.json({ state: "REVOKED" });
      return Response.json(LINK);
    }) as unknown as typeof fetch;
    const client = new HostArticleLinkClient(SESSION, fetchImpl, async () => "google-service-token");

    await expect(client.list("provider.synthetic:1")).resolves.toEqual([LINK]);
    await expect(client.invite("provider.synthetic:1", "writer@example.test")).resolves.toEqual(LINK);
    await expect(client.revoke("provider.synthetic:1", ID)).resolves.toBeUndefined();
    expect(calls).toEqual([
      { path: "/api/experience-guide-links/providers/provider.synthetic%3A1", method: "GET", body: undefined },
      { path: "/api/experience-guide-links/providers/provider.synthetic%3A1", method: "POST", body: JSON.stringify({ email: "writer@example.test" }) },
      { path: `/api/experience-guide-links/providers/provider.synthetic%3A1/${ID}/revoke`, method: "POST", body: "{}" },
    ]);
  });

  it("fails closed on malformed canonical DTOs and clears a rejected host session", async () => {
    const client = new HostArticleLinkClient(SESSION, vi.fn(async () => Response.json({ items: [{ ...LINK, writerNihoUserId: "private" }] })) as unknown as typeof fetch, async () => "google-service-token");
    await expect(client.list("provider-a")).rejects.toThrow("Invalid NIHO response");
    const error = Object.assign(new Error("rejected"), { status: 401 });
    const response = hostArticleLinkFailure(error);
    expect(response.status).toBe(401);
    expect(mocks.clearSession).toHaveBeenCalledWith(response);
  });
});

describe("ModernHostArticleLinkClient", () => {
  it("uses only the service identity and the strict host S2S contract", async () => {
    const calls: { path: string; authorization: string | null; body: unknown }[] = [];
    const fetchImpl = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({ path: new URL(String(input)).pathname, authorization: headers.get("authorization"), body: JSON.parse(String(init?.body)) });
      return Response.json(new URL(String(input)).pathname.endsWith("/list") ? { items: [LINK] } : new URL(String(input)).pathname.endsWith("/revoke") ? { state: "REVOKED" } : LINK);
    }) as unknown as typeof fetch;
    const client = new ModernHostArticleLinkClient("niho-owner-a", fetchImpl, async () => "service-token");
    await client.list("provider-a");
    await client.invite("provider-a", "writer@example.test");
    await client.revoke("provider-a", ID);
    expect(calls).toEqual([
      { path: "/api/internal/experience-article-link-hosts/providers/provider-a/list", authorization: null, body: { hostNihoUserId: "niho-owner-a" } },
      { path: "/api/internal/experience-article-link-hosts/providers/provider-a/invite", authorization: null, body: { hostNihoUserId: "niho-owner-a", email: "writer@example.test" } },
      { path: `/api/internal/experience-article-link-hosts/providers/provider-a/${ID}/revoke`, authorization: null, body: { hostNihoUserId: "niho-owner-a" } },
    ]);
  });
});
