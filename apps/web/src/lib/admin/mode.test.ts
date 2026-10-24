import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  config: {
    apiMode: "mock",
    adminSupportConsoleEnabled: true,
    adminSupportReadApiEnabled: false,
    adminSupportReadPreviewEnabled: false,
    hostSessionSecret: "a".repeat(40),
    adminSessionSecret: "b".repeat(40),
    adminOrigin: "",
    nihoWebOrigin: "https://niho.example",
    nihoFirebaseWebApiKey: "",
    siteUrl: "http://localhost:3000",
  },
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: state.config }));

import { isAdminHttp, isAdminHttpRead, isAdminPreview, isAdminReadPreview } from "./server";

describe("Admin mode boundary", () => {
  it("keeps the synthetic preview and real HTTP auth mutually exclusive and explicitly gated", () => {
    expect(isAdminPreview()).toBe(true);
    expect(isAdminHttp()).toBe(false);
    expect(isAdminHttpRead()).toBe(false);
    state.config.adminSupportReadPreviewEnabled = true;
    expect(isAdminReadPreview()).toBe(true);
    state.config.apiMode = "http";
    expect(isAdminPreview()).toBe(false);
    expect(isAdminHttp()).toBe(true);
    expect(isAdminReadPreview()).toBe(false);
    expect(isAdminHttpRead()).toBe(false);
    state.config.adminSupportReadApiEnabled = true;
    expect(isAdminHttpRead()).toBe(true);
    state.config.adminSupportConsoleEnabled = false;
    expect(isAdminPreview()).toBe(false);
    expect(isAdminHttp()).toBe(false);
    expect(isAdminHttpRead()).toBe(false);
  });

});
