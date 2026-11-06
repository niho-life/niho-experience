import { beforeEach, describe, expect, it, vi } from "vitest";

/** /host's identity and providers with Experience host accounts (ADR 0003): the experience DB only, never NIHO. */
const state = vi.hoisted(() => ({
  config: { apiMode: "http", hostConsoleEnabled: true, hostAccountsEnabled: true, experienceHostPublicationApiEnabled: true, hostSessionSecret: "synthetic-route-test-secret-0123456789abcdef" },
  cookies: {} as Record<string, string>,
  readSession: vi.fn(),
  listProviderMemberships: vi.fn(),
  identity: vi.fn(),
  listHostProviders: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("react", () => ({ cache: (read: unknown) => read }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (name: string) => (name in state.cookies ? { name, value: state.cookies[name] } : undefined) }) }));
vi.mock("google-auth-library", () => ({ GoogleAuth: class {
  async getIdTokenClient() { return { getRequestHeaders: async () => ({ authorization: "Bearer synthetic-service-token" }) }; }
} }));
vi.mock("@/lib/config", () => ({ config: state.config }));
vi.mock("@niho-experience/api-client/host", () => ({ createExperienceHostApiClient: () => ({ getIdentity: state.identity }) }));
vi.mock("@/lib/experience/store-server", () => ({
  hostAccounts: () => ({ readSession: state.readSession, listProviderMemberships: state.listProviderMemberships }),
  experiencePublicationRepository: () => ({ listHostProviders: state.listHostProviders, ensureMappedOwnerMembership: vi.fn() }),
}));

import { loadHostProvidersFresh, readHostSession } from "./server";
import { ACCOUNT_SESSION_COOKIE, SESSION_COOKIE } from "./session";

const TOKEN = "s".repeat(43);
const HOST = `hst_${"b".repeat(32)}`;
const stored = {
  hostAccountId: HOST, email: "synthetic-host@example.test", sessionRef: "0f8fad5b-d9cb-469f-a165-70867728950e",
  authenticatedAtUtc: "2026-11-07T00:00:00.000Z", idleExpiresAtUtc: "2026-11-21T00:00:00.000Z", absoluteExpiresAtUtc: "2026-12-07T00:00:00.000Z",
};

describe("Experience host accounts: session and providers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.config.hostAccountsEnabled = true;
    state.cookies = { [ACCOUNT_SESSION_COOKIE]: TOKEN };
    state.readSession.mockResolvedValue(stored);
    state.listProviderMemberships.mockResolvedValue([
      { providerId: "provider-kitchen", displayName: "Synthetic Kitchen", memberRole: "OWNER", legacyProviderId: null },
      { providerId: "provider-walk", displayName: "Synthetic Walk", memberRole: "EDITOR", legacyProviderId: "legacy-walk" },
    ]);
  });

  it("reads the session from the store by its cookie, as an Experience session", async () => {
    const session = await readHostSession();
    expect(session).toMatchObject({ kind: "experience", sessionToken: TOKEN, hostAccountId: HOST, displayName: "synthetic-host@example.test", iconUrl: null });
    expect(state.readSession).toHaveBeenCalledWith({ sessionToken: TOKEN, nowUtc: expect.stringMatching(/Z$/) });
  });

  it("ignores a NIHO cookie and a malformed account cookie without asking the store", async () => {
    state.cookies = { [SESSION_COOKIE]: "sealed-niho-session" };
    expect(await readHostSession()).toBeNull();
    state.cookies = { [ACCOUNT_SESSION_COOKIE]: "short" };
    expect(await readHostSession()).toBeNull();
    expect(state.readSession).not.toHaveBeenCalled();
  });

  it("lists the account's providers from its memberships, with the host account ID as the identity, and never calls NIHO", async () => {
    const load = await loadHostProvidersFresh();
    expect(load).toEqual({
      status: "ok",
      nihoUserId: HOST,
      providers: [
        { id: "provider-kitchen", legacyProviderId: "", displayName: "Synthetic Kitchen", memberRole: "OWNER", nihoUserId: HOST },
        { id: "provider-walk", legacyProviderId: "legacy-walk", displayName: "Synthetic Walk", memberRole: "EDITOR", nihoUserId: HOST },
      ],
    });
    expect(state.listProviderMemberships).toHaveBeenCalledWith({ hostAccountId: HOST });
    expect(state.identity).not.toHaveBeenCalled();
    expect(state.listHostProviders).not.toHaveBeenCalled();
  });

  it("reads as signed out without a session, and as an error when the store fails", async () => {
    state.readSession.mockResolvedValueOnce(null);
    expect(await loadHostProvidersFresh()).toEqual({ status: "signed-out" });
    state.readSession.mockRejectedValueOnce(new Error("db down"));
    expect(await loadHostProvidersFresh()).toEqual({ status: "error" });
    state.listProviderMemberships.mockRejectedValueOnce(new Error("db down"));
    expect(await loadHostProvidersFresh()).toEqual({ status: "error" });
    expect(state.identity).not.toHaveBeenCalled();
  });

  it("keeps the NIHO login when the flag is off: the account cookie is not read", async () => {
    state.config.hostAccountsEnabled = false;
    expect(await readHostSession()).toBeNull();
    expect(state.readSession).not.toHaveBeenCalled();
  });
});
