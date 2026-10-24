import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  config: { adminSupportCaseApiEnabled: false, adminSupportCasePreviewEnabled: false, nihoWebOrigin: "https://niho.example" },
  http: vi.fn(),
  read: vi.fn(),
  preview: vi.fn(),
  readPreview: vi.fn(),
  load: vi.fn(),
  clear: vi.fn(),
  createClient: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: mocks.config }));
vi.mock("@niho-experience/api-client/admin-support-case", () => ({ createExperienceAdminSupportCaseApiClient: mocks.createClient }));
vi.mock("./server", () => ({
  isAdminHttp: mocks.http,
  isAdminHttpRead: mocks.read,
  isAdminPreview: mocks.preview,
  isAdminReadPreview: mocks.readPreview,
  loadAdminHttpSession: mocks.load,
  clearAdminHttpSessionCookie: mocks.clear,
  adminJson: (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "private, no-store" } }),
}));

import { adminSupportCaseFailureJson, isAdminHttpSupportCase, isAdminSupportCasePreview, loadAdminSupportCaseClient } from "./case-server";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.config.adminSupportCaseApiEnabled = false;
  mocks.config.adminSupportCasePreviewEnabled = false;
  mocks.http.mockReturnValue(true);
  mocks.read.mockReturnValue(true);
  mocks.preview.mockReturnValue(true);
  mocks.readPreview.mockReturnValue(true);
  mocks.createClient.mockReturnValue({ marker: "case-client" });
});

describe("Admin support case server boundary", () => {
  it("requires both read and case flags and keeps preview independent", () => {
    expect(isAdminHttpSupportCase()).toBe(false);
    mocks.config.adminSupportCaseApiEnabled = true;
    expect(isAdminHttpSupportCase()).toBe(true);
    mocks.read.mockReturnValue(false);
    expect(isAdminHttpSupportCase()).toBe(false);
    expect(isAdminSupportCasePreview()).toBe(false);
    mocks.config.adminSupportCasePreviewEnabled = true;
    expect(isAdminSupportCasePreview()).toBe(true);
  });

  it("keeps the BFF closed for preview-only and requires the HTTP gate", async () => {
    mocks.config.adminSupportCasePreviewEnabled = true;
    mocks.config.adminSupportCaseApiEnabled = false;
    let loaded = await loadAdminSupportCaseClient();
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.response.status).toBe(404);
    expect(mocks.load).not.toHaveBeenCalled();

    mocks.config.adminSupportCaseApiEnabled = true;
    mocks.http.mockReturnValue(false);
    loaded = await loadAdminSupportCaseClient();
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.response.status).toBe(404);
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it("re-verifies the current dedicated session before constructing a client", async () => {
    mocks.config.adminSupportCaseApiEnabled = true;
    mocks.load.mockResolvedValue({ status: "ok", session: { idToken: "server-only-token" } });
    const loaded = await loadAdminSupportCaseClient();
    expect(loaded).toEqual({ ok: true, client: { marker: "case-client" } });
    expect(mocks.load).toHaveBeenCalledOnce();
    expect(mocks.createClient).toHaveBeenCalledWith(expect.objectContaining({ nihoWebOrigin: "https://niho.example", idToken: "server-only-token" }));
  });

  it("maps expired/rejected/error sessions without exposing a token", async () => {
    mocks.config.adminSupportCaseApiEnabled = true;
    mocks.load.mockResolvedValue({ status: "refresh", session: {} });
    let loaded = await loadAdminSupportCaseClient();
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.response.status).toBe(401);
      expect(await loaded.response.json()).toEqual({ error: "refresh_required" });
    }
    mocks.load.mockResolvedValue({ status: "rejected" });
    loaded = await loadAdminSupportCaseClient();
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.response.status).toBe(401);
    expect(mocks.clear).toHaveBeenCalledOnce();
    mocks.load.mockResolvedValue({ status: "error" });
    loaded = await loadAdminSupportCaseClient();
    if (!loaded.ok) expect(loaded.response.status).toBe(503);
  });

  it("selects only the conflict reason and clears both upstream rejection statuses", async () => {
    const conflict = adminSupportCaseFailureJson({ ok: false, kind: "conflict", reason: "SUPPORT_OFF" });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: "conflict", reason: "SUPPORT_OFF" });
    const rejected = adminSupportCaseFailureJson({ ok: false, kind: "rejected", status: 403 });
    expect(rejected.status).toBe(401);
    expect(mocks.clear).toHaveBeenCalledOnce();
    expect(await rejected.json()).toEqual({ error: "signed_out" });
    const unauthorized = adminSupportCaseFailureJson({ ok: false, kind: "rejected", status: 401 });
    expect(unauthorized.status).toBe(401);
    expect(mocks.clear).toHaveBeenCalledTimes(2);
  });
});
