import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  config: {
    hostConsoleEnabled: true,
    apiMode: "http" as "mock" | "http",
    experienceProviderPagesApiEnabled: false,
    experienceProviderOperationsApiEnabled: false,
    experienceProviderOperationsPreviewEnabled: false,
  },
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: state.config }));
vi.mock("./provider-operations-server", () => ({
  providerOperationsEnabled: () => state.config.hostConsoleEnabled && (state.config.experienceProviderOperationsApiEnabled || state.config.experienceProviderOperationsPreviewEnabled),
  providerOperationsJson: (body: unknown, status = 200) => Response.json(body, { status }),
}));
vi.mock("./server", () => ({ hostApiClient: vi.fn(), readHostSession: vi.fn(), clearSessionCookie: vi.fn() }));
vi.mock("./session", () => ({ accessTokenUsable: vi.fn() }));

import { providerPagesEnabled } from "./provider-pages-server";

describe("provider pages rollout gate", () => {
  beforeEach(() => {
    Object.assign(state.config, {
      hostConsoleEnabled: true,
      apiMode: "http",
      experienceProviderPagesApiEnabled: false,
      experienceProviderOperationsApiEnabled: false,
      experienceProviderOperationsPreviewEnabled: false,
    });
  });

  it("stays closed by default and without the host console", () => {
    expect(providerPagesEnabled()).toBe(false);
    state.config.experienceProviderPagesApiEnabled = true;
    state.config.hostConsoleEnabled = false;
    expect(providerPagesEnabled()).toBe(false);
  });

  it("keeps the legacy page API closed in HTTP mode even when rollout flags are set", () => {
    state.config.experienceProviderPagesApiEnabled = true;
    state.config.experienceProviderOperationsApiEnabled = true;
    expect(providerPagesEnabled()).toBe(false);
  });

  it("keeps the live editor available only in the explicit synthetic preview", () => {
    state.config.apiMode = "mock";
    state.config.experienceProviderOperationsPreviewEnabled = true;
    expect(providerPagesEnabled()).toBe(true);
    state.config.experienceProviderOperationsPreviewEnabled = false;
    expect(providerPagesEnabled()).toBe(false);
    state.config.experienceProviderOperationsPreviewEnabled = true;
    state.config.hostConsoleEnabled = false;
    expect(providerPagesEnabled()).toBe(false);
  });
});
