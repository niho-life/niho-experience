import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ config: { apiMode: "mock", hostConsoleEnabled: true, hostSupportHistoryApiEnabled: false, nihoWebOrigin: "https://niho.example" }, read: vi.fn(), usable: vi.fn(), create: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: mocks.config }));
vi.mock("@niho-experience/api-client/host-support-history", () => ({ createExperienceHostSupportHistoryApiClient: mocks.create }));
vi.mock("./session", () => ({ idTokenUsable: mocks.usable }));
vi.mock("./server", () => ({ readHostSession: mocks.read, hostNotFound: () => Response.json({ error: "not_found" }, { status: 404 }), noStoreJson: (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "private, no-store" } }) }));
import { isHostSupportHistoryEnabled, loadHostSupportHistoryClient } from "./support-history-server";

beforeEach(() => { vi.clearAllMocks(); Object.assign(mocks.config, { apiMode: "mock", hostConsoleEnabled: true, hostSupportHistoryApiEnabled: false }); mocks.usable.mockReturnValue(true); mocks.create.mockReturnValue({ marker: "history-client" }); });
describe("Host support history server boundary", () => {
  it("is exact-flag HTTP-only and has no mock fallback", async () => { expect(isHostSupportHistoryEnabled()).toBe(false); mocks.config.hostSupportHistoryApiEnabled = true; expect(isHostSupportHistoryEnabled()).toBe(false); const loaded = await loadHostSupportHistoryClient(); expect(loaded.ok).toBe(false); expect(mocks.read).not.toHaveBeenCalled(); });
  it("uses only the sealed host token and lets NIHO validate ownership", async () => { Object.assign(mocks.config, { apiMode: "http", hostSupportHistoryApiEnabled: true }); mocks.read.mockResolvedValue({ idToken: "server-only-host-token" }); const loaded = await loadHostSupportHistoryClient(); expect(loaded).toEqual({ ok: true, client: { marker: "history-client" } }); expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ idToken: "server-only-host-token", nihoWebOrigin: "https://niho.example" })); });
  it("closes missing and expiring sessions before an upstream read", async () => { Object.assign(mocks.config, { apiMode: "http", hostSupportHistoryApiEnabled: true }); mocks.read.mockResolvedValue(null); let loaded = await loadHostSupportHistoryClient(); if (!loaded.ok) expect(loaded.response.status).toBe(401); mocks.read.mockResolvedValue({ idToken: "token" }); mocks.usable.mockReturnValue(false); loaded = await loadHostSupportHistoryClient(); if (!loaded.ok) expect(await loaded.response.json()).toEqual({ error: "session_refresh_required" }); expect(mocks.create).not.toHaveBeenCalled(); });
});
