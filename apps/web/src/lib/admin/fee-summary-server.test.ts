import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ config: { experienceFeeSummaryApiEnabled: false, experienceFeeSummaryPreviewEnabled: false, nihoWebOrigin: "https://niho.example" }, http: vi.fn(), readPreview: vi.fn(), load: vi.fn(), clear: vi.fn(), create: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: mocks.config }));
vi.mock("@niho-experience/api-client/fee-summary-server", () => ({ createExperienceFeeSummaryApiClient: mocks.create }));
vi.mock("./server", () => ({ isAdminHttp: mocks.http, isAdminReadPreview: mocks.readPreview, loadAdminHttpSession: mocks.load, clearAdminHttpSessionCookie: mocks.clear, adminJson: (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "private, no-store" } }) }));

import { adminFeeSummaryFailureJson, isAdminFeeSummaryEnabled, isAdminFeeSummaryPreview, loadAdminFeeSummaryClient } from "./fee-summary-server";

beforeEach(() => { vi.clearAllMocks(); Object.assign(mocks.config, { experienceFeeSummaryApiEnabled: false, experienceFeeSummaryPreviewEnabled: false }); mocks.http.mockReturnValue(true); mocks.readPreview.mockReturnValue(true); mocks.create.mockReturnValue({ marker: "fee-client" }); });

describe("Admin fee summary server boundary", () => {
  it("keeps HTTP and preview behind separate exact gates", () => {
    expect(isAdminFeeSummaryEnabled()).toBe(false); expect(isAdminFeeSummaryPreview()).toBe(false);
    mocks.config.experienceFeeSummaryApiEnabled = true; expect(isAdminFeeSummaryEnabled()).toBe(true);
    mocks.http.mockReturnValue(false); expect(isAdminFeeSummaryEnabled()).toBe(false);
    mocks.config.experienceFeeSummaryPreviewEnabled = true; expect(isAdminFeeSummaryPreview()).toBe(true);
  });

  it("re-verifies the current ADMIN session and creates only the admin client", async () => {
    mocks.config.experienceFeeSummaryApiEnabled = true;
    mocks.load.mockResolvedValue({ status: "ok", session: { idToken: "server-admin-token" } });
    const loaded = await loadAdminFeeSummaryClient();
    expect(loaded).toEqual({ ok: true, client: { marker: "fee-client" } });
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ audience: "admin", idToken: "server-admin-token", nihoWebOrigin: "https://niho.example" }));
  });

  it("clears the dedicated session for upstream 401 and 403", async () => {
    for (const status of [401, 403] as const) {
      const response = adminFeeSummaryFailureJson({ ok: false, kind: "rejected", status });
      expect(response.status).toBe(status);
    }
    expect(mocks.clear).toHaveBeenCalledTimes(2);
  });
});

