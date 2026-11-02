import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  config: { hostConsoleEnabled: true, experienceProviderPagesApiEnabled: false },
  operations: false,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: state.config }));
vi.mock("./provider-operations-server", () => ({
  providerOperationsEnabled: () => state.operations,
  providerOperationsJson: (body: unknown, status = 200) => Response.json(body, { status }),
}));
vi.mock("./server", () => ({ hostApiClient: vi.fn(), readHostSession: vi.fn(), clearSessionCookie: vi.fn() }));
vi.mock("./session", () => ({ accessTokenUsable: vi.fn() }));

import { providerPagesEnabled } from "./provider-pages-server";

describe("provider pages rollout gate", () => {
  beforeEach(() => {
    Object.assign(state.config, { hostConsoleEnabled: true, experienceProviderPagesApiEnabled: false });
    state.operations = false;
  });

  it("stays closed by default and without the host console", () => {
    expect(providerPagesEnabled()).toBe(false);
    state.config.experienceProviderPagesApiEnabled = true;
    state.config.hostConsoleEnabled = false;
    expect(providerPagesEnabled()).toBe(false);
  });

  it("opens page authoring independently from broader provider operations", () => {
    state.config.experienceProviderPagesApiEnabled = true;
    expect(providerPagesEnabled()).toBe(true);
    expect(state.operations).toBe(false);
  });

  it("keeps the previous provider-operations rollout compatible", () => {
    state.operations = true;
    expect(providerPagesEnabled()).toBe(true);
  });
});
