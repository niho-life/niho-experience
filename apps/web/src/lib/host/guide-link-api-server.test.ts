import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  config: { hostConsoleEnabled: true },
  editorEnabled: vi.fn(() => true),
  readSession: vi.fn(),
  authMe: vi.fn(),
  clearSession: vi.fn(),
  repositoryFactory: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: mocks.config }));
vi.mock("@/lib/editor/server", () => ({ isEditorConsole: mocks.editorEnabled }));
vi.mock("@/lib/experience/store-server", () => ({ guideRepository: mocks.repositoryFactory }));
vi.mock("@/lib/host/server", () => ({
  readHostSession: mocks.readSession,
  hostApiClient: () => ({ getAuthMe: mocks.authMe }),
  clearSessionCookie: mocks.clearSession,
  noStoreJson: (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "private, no-store" } }),
}));

import { loadHostGuideLinkContext } from "./guide-link-api-server";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.config.hostConsoleEnabled = true;
  mocks.editorEnabled.mockReturnValue(true);
  mocks.readSession.mockResolvedValue({ nihoUserId: "owner-a", idToken: "secret", idTokenExpiresAt: Date.now() + 3_600_000 });
  mocks.authMe.mockResolvedValue({ ok: true, data: { user: { id: "owner-a" } } });
  mocks.repositoryFactory.mockReturnValue({});
});

describe("host guide link identity boundary", () => {
  it("checks NIHO identity before exposing the Experience Store", async () => {
    const loaded = await loadHostGuideLinkContext();
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.value.actor).toEqual({ nihoUserId: "owner-a" });
    expect(mocks.authMe).toHaveBeenCalledTimes(1);
    expect(mocks.repositoryFactory).toHaveBeenCalledTimes(1);
  });

  it("clears a stale or mismatched host session", async () => {
    mocks.authMe.mockResolvedValueOnce({ ok: true, data: { user: { id: "other-account" } } });
    const mismatch = await loadHostGuideLinkContext();
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.response.status).toBe(401);
    expect(mocks.clearSession).toHaveBeenCalledTimes(1);
    expect(mocks.repositoryFactory).not.toHaveBeenCalled();

    mocks.authMe.mockResolvedValueOnce({ ok: false, kind: "error", status: 401 });
    const revoked = await loadHostGuideLinkContext();
    expect(revoked.ok).toBe(false);
    if (!revoked.ok) expect(revoked.response.status).toBe(401);
    expect(mocks.clearSession).toHaveBeenCalledTimes(2);
  });

  it("fails closed on NIHO outage and while the feature is disabled", async () => {
    mocks.authMe.mockResolvedValueOnce({ ok: false, kind: "network_error" });
    const outage = await loadHostGuideLinkContext();
    expect(outage.ok).toBe(false);
    if (!outage.ok) expect(outage.response.status).toBe(503);
    mocks.editorEnabled.mockReturnValue(false);
    const disabled = await loadHostGuideLinkContext();
    expect(disabled.ok).toBe(false);
    if (!disabled.ok) expect(disabled.response.status).toBe(404);
    expect(mocks.repositoryFactory).not.toHaveBeenCalled();
  });
});
