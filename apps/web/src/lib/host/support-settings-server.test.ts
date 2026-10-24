import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ config: { apiMode: "mock", hostConsoleEnabled: true, hostSupportSettingsApiEnabled: false, hostSupportSettingsPreviewEnabled: false, nihoWebOrigin: "https://niho.example" }, read: vi.fn(), usable: vi.fn(), create: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: mocks.config }));
vi.mock("./session", () => ({ idTokenUsable: mocks.usable }));
vi.mock("./server", () => ({ readHostSession: mocks.read, hostNotFound: () => Response.json({ error: "not_found" }, { status: 404, headers: { "cache-control": "private, no-store" } }), noStoreJson: (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "private, no-store" } }) }));
vi.mock("@niho-experience/api-client/host-support-settings", () => ({ createExperienceHostSupportSettingsApiClient: mocks.create }));
import { isHostSupportSettingsEnabled, isHostSupportSettingsPreview, loadHostSupportSettingsClient } from "./support-settings-server";

describe("Host support settings server boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(mocks.config, { apiMode: "mock", hostConsoleEnabled: true, hostSupportSettingsApiEnabled: false, hostSupportSettingsPreviewEnabled: false });
    mocks.usable.mockReturnValue(true);
    mocks.create.mockReturnValue({ marker: "settings-client" });
  });

  it("keeps HTTP default OFF and never lets preview open the BFF", async () => {
    expect(isHostSupportSettingsEnabled()).toBe(false);
    mocks.config.hostSupportSettingsPreviewEnabled = true;
    expect(isHostSupportSettingsPreview()).toBe(true);
    expect(isHostSupportSettingsEnabled()).toBe(false);
    const loaded = await loadHostSupportSettingsClient();
    expect(loaded.ok).toBe(false);
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it("uses only the sealed host token and NIHO remains the OWNER authority", async () => {
    Object.assign(mocks.config, { apiMode: "http", hostSupportSettingsApiEnabled: true, hostSupportSettingsPreviewEnabled: true });
    mocks.read.mockResolvedValue({ idToken: "server-only-host-token" });
    const loaded = await loadHostSupportSettingsClient();
    expect(loaded).toEqual({ ok: true, client: { marker: "settings-client" } });
    expect(isHostSupportSettingsPreview()).toBe(false);
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ idToken: "server-only-host-token", nihoWebOrigin: "https://niho.example" }));
  });

  it("closes missing and expiring sessions before an upstream request", async () => {
    Object.assign(mocks.config, { apiMode: "http", hostSupportSettingsApiEnabled: true });
    mocks.read.mockResolvedValue(null);
    let loaded = await loadHostSupportSettingsClient();
    if (!loaded.ok) expect(loaded.response.status).toBe(401);
    mocks.read.mockResolvedValue({ idToken: "token" });
    mocks.usable.mockReturnValue(false);
    loaded = await loadHostSupportSettingsClient();
    if (!loaded.ok) expect(await loaded.response.json()).toEqual({ error: "session_refresh_required" });
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
