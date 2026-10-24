import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ config: { adminOperationsApiEnabled: false, adminOperationsPreviewEnabled: false, nihoWebOrigin: "https://niho.example" }, http: vi.fn(), read: vi.fn(), preview: vi.fn(), readPreview: vi.fn(), load: vi.fn(), clear: vi.fn(), create: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: mocks.config }));
vi.mock("@niho-experience/api-client/admin-operations", () => ({ createExperienceAdminOperationsApiClient: mocks.create }));
vi.mock("./server", () => ({ isAdminHttp: mocks.http, isAdminHttpRead: mocks.read, isAdminPreview: mocks.preview, isAdminReadPreview: mocks.readPreview, loadAdminHttpSession: mocks.load, clearAdminHttpSessionCookie: mocks.clear, adminJson: (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "private, no-store" } }) }));
import { adminOperationsFailureJson, isAdminHttpOperations, isAdminOperationsPreview, loadAdminOperationsClient } from "./operations-server";

beforeEach(() => { vi.clearAllMocks(); mocks.config.adminOperationsApiEnabled = false; mocks.config.adminOperationsPreviewEnabled = false; mocks.http.mockReturnValue(true); mocks.read.mockReturnValue(true); mocks.preview.mockReturnValue(true); mocks.readPreview.mockReturnValue(true); mocks.create.mockReturnValue({ marker: "operations-client" }); });
describe("Admin operations server boundary", () => {
  it("requires the independent operations flag plus read and keeps preview separate", () => { expect(isAdminHttpOperations()).toBe(false); mocks.config.adminOperationsApiEnabled = true; expect(isAdminHttpOperations()).toBe(true); mocks.read.mockReturnValue(false); expect(isAdminHttpOperations()).toBe(false); expect(isAdminOperationsPreview()).toBe(false); mocks.config.adminOperationsPreviewEnabled = true; expect(isAdminOperationsPreview()).toBe(true); });
  it("re-verifies the current dedicated ADMIN session for every BFF load", async () => { mocks.config.adminOperationsApiEnabled = true; mocks.load.mockResolvedValue({ status: "ok", session: { idToken: "server-only-token" } }); const loaded = await loadAdminOperationsClient(); expect(loaded).toEqual({ ok: true, client: { marker: "operations-client" } }); expect(mocks.load).toHaveBeenCalledOnce(); expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ idToken: "server-only-token", nihoWebOrigin: "https://niho.example" })); });
  it("clears rejected sessions and never constructs a client for expired/error states", async () => { mocks.config.adminOperationsApiEnabled = true; mocks.load.mockResolvedValue({ status: "rejected" }); let loaded = await loadAdminOperationsClient(); expect(loaded.ok).toBe(false); expect(mocks.clear).toHaveBeenCalledOnce(); mocks.load.mockResolvedValue({ status: "refresh" }); loaded = await loadAdminOperationsClient(); if (!loaded.ok) expect(loaded.response.status).toBe(401); mocks.load.mockResolvedValue({ status: "error" }); loaded = await loadAdminOperationsClient(); if (!loaded.ok) expect(loaded.response.status).toBe(503); });
  it("forwards only selected unaccepted conflicts and isolates operation ID reuse", async () => {
    const conflict = adminOperationsFailureJson({ ok: false, kind: "conflict", reason: "BOOKING_SNAPSHOT_CHANGED" });
    expect(conflict.status).toBe(409); expect(await conflict.json()).toEqual({ error: "conflict", reason: "BOOKING_SNAPSHOT_CHANGED" });
    const reused = adminOperationsFailureJson({ ok: false, kind: "operation_id_reused" });
    expect(reused.status).toBe(409); expect(await reused.json()).toEqual({ error: "operation_id_reused" });
  });
});
