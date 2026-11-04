import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  config: { apiMode: "http", hostConsoleEnabled: true, experienceHostPublicationApiEnabled: true },
  session: vi.fn(), usable: vi.fn(), identity: vi.fn(), list: vi.fn(), bind: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("react", () => ({ cache: (read: unknown) => read }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("google-auth-library", () => ({ GoogleAuth: class {
  async getIdTokenClient() { return { getRequestHeaders: async () => ({ authorization: "Bearer synthetic-service-token" }) }; }
} }));
vi.mock("@/lib/config", () => ({ config: state.config }));
vi.mock("./cookie-seal", () => ({ cookieSealer: () => ({}) }));
vi.mock("./session", async (importOriginal) => ({
  ...await importOriginal<typeof import("./session")>(),
  decodeSession: state.session,
  accessTokenUsable: state.usable,
}));
vi.mock("@niho-experience/api-client/host", () => ({
  createExperienceHostApiClient: () => ({ getIdentity: state.identity }),
}));
vi.mock("@/lib/experience/store-server", () => ({ experiencePublicationRepository: () => ({
  listHostProviders: state.list,
  ensureMappedOwnerMembership: state.bind,
}) }));

import { loadHostProviders } from "./server";

const membership = {
  providerId: "synthetic-seller", legacyProviderId: "synthetic-legacy", providerDisplayName: "Synthetic seller",
  memberRole: "OWNER", sellerNihoAccountRef: "synthetic-current-person", stripeConnectAccountRef: "acct_synthetic",
};

describe("first host visit after seller provisioning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.config.experienceHostPublicationApiEnabled = true;
    state.session.mockReturnValue({ accessToken: "synthetic-access-token" });
    state.usable.mockReturnValue(true);
    state.identity.mockResolvedValue({ ok: true, data: { nihoUserId: "synthetic-current-person", accountStatus: "ACTIVE" } });
    state.list.mockResolvedValue([]);
    state.bind.mockResolvedValue({ kind: "linked" });
  });

  it("opens the seller console on the first visit, before any product API request", async () => {
    state.list.mockResolvedValueOnce([]).mockResolvedValueOnce([membership]);
    expect(await loadHostProviders()).toMatchObject({ status: "ok", providers: [{ id: "synthetic-seller", memberRole: "OWNER" }] });
    expect(state.bind).toHaveBeenCalledWith("synthetic-current-person");
    expect(state.list).toHaveBeenNthCalledWith(2, "synthetic-current-person");
  });

  it("keeps an existing editor role without trying to grant ownership", async () => {
    state.list.mockResolvedValue([{ ...membership, memberRole: "EDITOR" }]);
    expect(await loadHostProviders()).toMatchObject({ status: "ok", providers: [{ memberRole: "EDITOR" }] });
    expect(state.bind).not.toHaveBeenCalled();
  });

  it("leaves an account without a provisioned mapping unregistered", async () => {
    state.bind.mockResolvedValue({ kind: "no-mapping" });
    expect(await loadHostProviders()).toMatchObject({ status: "ok", providers: [] });
  });

  it.each(["ambiguous", "membership-conflict"])("refuses a %s mapping", async (kind) => {
    state.bind.mockResolvedValue({ kind });
    expect(await loadHostProviders()).toEqual({ status: "error" });
    expect(state.list).toHaveBeenCalledOnce();
  });

  it("does not create memberships while publication is disabled", async () => {
    state.config.experienceHostPublicationApiEnabled = false;
    expect(await loadHostProviders()).toMatchObject({ status: "ok", providers: [] });
    expect(state.bind).not.toHaveBeenCalled();
  });

  it("requires a currently verified NIHO identity before any local membership write", async () => {
    state.identity.mockResolvedValue({ ok: false, kind: "error", status: 401 });
    expect(await loadHostProviders()).toEqual({ status: "rejected" });
    expect(state.bind).not.toHaveBeenCalled();
    expect(state.list).not.toHaveBeenCalled();
  });
});
