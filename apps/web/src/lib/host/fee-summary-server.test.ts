import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ config: { apiMode: "mock", hostConsoleEnabled: true, experienceFeeSummaryApiEnabled: false, experienceFeeSummaryPreviewEnabled: false, nihoWebOrigin: "https://niho.example" }, read: vi.fn(), usable: vi.fn(), create: vi.fn(), clear: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: mocks.config }));
vi.mock("@niho-experience/api-client/fee-summary-server", () => ({ createExperienceFeeSummaryApiClient: mocks.create }));
vi.mock("./session", () => ({ idTokenUsable: mocks.usable }));
vi.mock("./server", () => ({ readHostSession: mocks.read, clearSessionCookie: mocks.clear, hostNotFound: () => Response.json({ error: "not_found" }, { status: 404 }), noStoreJson: (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "private, no-store" } }) }));

import { hostFeeSummaryFailureJson, isHostFeeSummaryEnabled, isHostFeeSummaryPreview, loadHostFeeSummaryClient } from "./fee-summary-server";

beforeEach(() => { vi.clearAllMocks(); Object.assign(mocks.config, { apiMode: "mock", hostConsoleEnabled: true, experienceFeeSummaryApiEnabled: false, experienceFeeSummaryPreviewEnabled: false }); mocks.usable.mockReturnValue(true); mocks.create.mockReturnValue({ marker: "fee-client" }); });

describe("Host fee summary server boundary", () => {
  it("does not let the preview flag open the real BFF", async () => {
    mocks.config.experienceFeeSummaryPreviewEnabled = true;
    expect(isHostFeeSummaryPreview()).toBe(true); expect(isHostFeeSummaryEnabled()).toBe(false);
    const loaded = await loadHostFeeSummaryClient(); expect(loaded.ok).toBe(false); expect(mocks.read).not.toHaveBeenCalled();
  });

  it("uses the sealed usable host token for both host kinds to be authorized upstream", async () => {
    Object.assign(mocks.config, { apiMode: "http", experienceFeeSummaryApiEnabled: true });
    mocks.read.mockResolvedValue({ idToken: "server-host-token" });
    const loaded = await loadHostFeeSummaryClient();
    expect(loaded).toEqual({ ok: true, client: { marker: "fee-client" } });
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ audience: "host", idToken: "server-host-token", nihoWebOrigin: "https://niho.example" }));
  });

  it("closes missing and expiring sessions before upstream", async () => {
    Object.assign(mocks.config, { apiMode: "http", experienceFeeSummaryApiEnabled: true });
    mocks.read.mockResolvedValue(null); let loaded = await loadHostFeeSummaryClient(); if (!loaded.ok) expect(loaded.response.status).toBe(401);
    mocks.read.mockResolvedValue({ idToken: "token" }); mocks.usable.mockReturnValue(false); loaded = await loadHostFeeSummaryClient(); if (!loaded.ok) expect(await loaded.response.json()).toEqual({ error: "session_refresh_required" });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("clears the sealed host session when NIHO rejects either token or ownership", async () => {
    for (const status of [401, 403] as const) expect(hostFeeSummaryFailureJson({ ok: false, kind: "rejected", status }).status).toBe(status);
    expect(mocks.clear).toHaveBeenCalledTimes(2);
  });
});
