import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  config: {
    hostConsoleEnabled: true,
    experienceProviderOperationsApiEnabled: false,
    experienceProviderOperationsPreviewEnabled: false,
    nihoWebOrigin: "https://niho.example",
  },
  readHost: vi.fn(),
  usable: vi.fn(),
  create: vi.fn(),
  clear: vi.fn(),
  upstreamFetch: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: mocks.config }));
vi.mock("./session", () => ({ idTokenUsable: mocks.usable }));
vi.mock("./server", () => ({
  readHostSession: mocks.readHost,
  nihoApiFetch: () => mocks.upstreamFetch,
  siteOrigin: () => "https://experience.example",
  clearSessionCookie: mocks.clear,
}));
vi.mock("@niho-experience/api-client/experience-provider-operations", () => ({
  createExperienceProviderOperationsClient: mocks.create,
}));

import {
  loadProviderOperationsClient,
  providerOperationsEnabled,
  providerOperationsFailure,
  providerOperationsMutationAllowed,
  readProviderOperationsJson,
} from "./provider-operations-server";

describe("provider operations server boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(mocks.config, {
      hostConsoleEnabled: true,
      experienceProviderOperationsApiEnabled: false,
      experienceProviderOperationsPreviewEnabled: false,
    });
    mocks.usable.mockReturnValue(true);
    mocks.create.mockReturnValue({ marker: "operations-client" });
  });

  it("is independently default-off and requires the host console", () => {
    expect(providerOperationsEnabled()).toBe(false);
    mocks.config.experienceProviderOperationsApiEnabled = true;
    expect(providerOperationsEnabled()).toBe(true);
    mocks.config.hostConsoleEnabled = false;
    expect(providerOperationsEnabled()).toBe(false);
  });

  it("uses only the sealed current host session, never an Admin token", async () => {
    mocks.config.experienceProviderOperationsApiEnabled = true;
    mocks.readHost.mockResolvedValue({ idToken: "sealed-host-token" });
    const loaded = await loadProviderOperationsClient();
    expect(loaded).toEqual({ ok: true, client: { marker: "operations-client" } });
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      idToken: "sealed-host-token",
      nihoWebOrigin: "https://niho.example",
      fetch: mocks.upstreamFetch,
    }));
  });

  it("fails closed for missing or expired host sessions", async () => {
    mocks.config.experienceProviderOperationsApiEnabled = true;
    mocks.readHost.mockResolvedValue(null);
    let result = await loadProviderOperationsClient();
    if (!result.ok) expect(result.response.status).toBe(401);
    mocks.readHost.mockResolvedValue({ idToken: "expired" });
    mocks.usable.mockReturnValue(false);
    result = await loadProviderOperationsClient();
    if (!result.ok) expect(await result.response.json()).toEqual({ error: "session_refresh_required" });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("requires same-origin evidence for every mutation", () => {
    const request = (origin: string, site = "same-origin") => new Request("https://experience.example/host/api/provider-operations/p/members", {
      method: "POST", headers: { origin, "sec-fetch-site": site }, body: "{}",
    });
    expect(providerOperationsMutationAllowed(request("https://experience.example"))).toBe(true);
    expect(providerOperationsMutationAllowed(request("https://evil.example", "cross-site"))).toBe(false);
  });

  it("bounds JSON by declared and actual UTF-8 bytes and rejects invalid JSON", async () => {
    const request = (body: string, length?: string) => new Request("https://experience.example/host/api/provider-operations/p/members", {
      method: "POST", headers: { ...(length ? { "content-length": length } : {}) }, body,
    });
    expect(await readProviderOperationsJson(request('{"role":"COHOST"}'), 64)).toEqual({ ok: true, value: { role: "COHOST" } });
    expect(await readProviderOperationsJson(request("{}", "65"), 64)).toEqual({ ok: false });
    expect(await readProviderOperationsJson(request(`{"x":"${"界".repeat(30)}"}`), 64)).toEqual({ ok: false });
    expect(await readProviderOperationsJson(request("{"), 64)).toEqual({ ok: false });
  });

  it("clears the host cookie on 401 and reports 403/404 as ended permission", async () => {
    const unauthenticated = providerOperationsFailure({ ok: false, kind: "rejected", status: 401 });
    expect(unauthenticated.status).toBe(401);
    expect(mocks.clear).toHaveBeenCalledWith(unauthenticated);
    const forbidden = providerOperationsFailure({ ok: false, kind: "rejected", status: 403 });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ error: "permission_ended" });
    const revoked = providerOperationsFailure({ ok: false, kind: "not_found" });
    expect(revoked.status).toBe(404);
    expect(await revoked.json()).toEqual({ error: "permission_ended" });
  });
});
