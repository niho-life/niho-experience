import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enabled: true, csrf: true, load: vi.fn(), runtime: null as Record<string, ReturnType<typeof vi.fn>> | null,
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/admin/server", () => ({ adminMutationAllowed: () => mocks.csrf, loadAdminHttpSession: mocks.load }));
vi.mock("@/lib/experience/channel-runtime", async () => {
  const actual = await vi.importActual<typeof import("@/lib/experience/channel-runtime")>("@/lib/experience/channel-runtime");
  return { ...actual, channelManagerEnabled: () => mocks.enabled };
});
vi.mock("@/lib/experience/store-server", () => ({ channelRuntime: () => mocks.runtime }));

import { POST } from "./route";

const request = (body: unknown) => new Request("https://experience.example/admin/api/channels", {
  method: "POST", headers: { "content-type": "application/json", origin: "https://experience.example", "sec-fetch-site": "same-origin" }, body: JSON.stringify(body),
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.enabled = true;
  mocks.csrf = true;
  mocks.load.mockResolvedValue({ status: "ok", verified: { actor: { id: "verified-admin" } } });
  mocks.runtime = { listExternalAccounts: vi.fn().mockResolvedValue([]), listListings: vi.fn().mockResolvedValue([]) };
});

describe("Admin channel BFF", () => {
  it("checks the dedicated flag, CSRF, and fresh Admin session before the store", async () => {
    mocks.enabled = false;
    expect((await POST(request({ action: "listAccounts", providerId: "provider-a" }))).status).toBe(404);
    expect(mocks.load).not.toHaveBeenCalled();
    mocks.enabled = true; mocks.csrf = false;
    expect((await POST(request({ action: "listAccounts", providerId: "provider-a" }))).status).toBe(403);
    expect(mocks.load).not.toHaveBeenCalled();
    mocks.csrf = true; mocks.load.mockResolvedValue({ status: "refresh" });
    expect((await POST(request({ action: "listAccounts", providerId: "provider-a" }))).status).toBe(401);
  });

  it("rejects unknown actions and oversized bodies", async () => {
    expect((await POST(request({ action: "arbitraryQuery", sql: "select *" }))).status).toBe(400);
    expect((await POST(request({ action: "listAccounts", providerId: "p", padding: "x".repeat(17 * 1024) }))).status).toBe(413);
  });

  it("uses the verified actor and strips private profile fields from chosen DTOs", async () => {
    const account = {
      id: "account-a", providerId: "provider-a", site: "Airbnb", externalAccountId: "external-a", displayName: "Account",
      operatingModel: 2, active: false, version: 1, quarantined: false, createdAtUtc: "2099-01-01T00:00:00.000Z", updatedAtUtc: "2099-01-01T00:00:00.000Z",
      privateProfileRef: "must-not-leak", credentialDigest: "must-not-leak",
    };
    mocks.runtime!.listExternalAccounts!.mockResolvedValue([account]);
    const response = await POST(request({ action: "listAccounts", providerId: "provider-a" }));
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(JSON.stringify(data)).not.toContain("must-not-leak");
    expect(mocks.runtime!.listExternalAccounts!).toHaveBeenCalledWith({ nihoUserId: "verified-admin" }, "provider-a");
  });
});
