import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  config: { nihoAccountStatusCheckEnabled: true, nihoWebOrigin: "https://niho.example.test" },
  tokenFails: false,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: state.config }));
vi.mock("@/lib/experience/store-server", () => ({ nihoAccountStatusStore: () => null }));
vi.mock("./service-identity", () => ({
  experienceHostServiceIdToken: async () => {
    if (state.tokenFails) throw new Error("synthetic metadata service outage");
    return "synthetic-service-id-token";
  },
}));

import type { NihoAccountStatusStore } from "@niho-experience/experience-store";
import { checkNihoAccountStatusSession } from "./account-status";

const NIHO_ID = "niho-user-synthetic-status";

function fakeStore(result: { kind: "active" | "ended" | "stale" | "merged"; conflicts?: readonly ("host" | "traveler")[] } = { kind: "active" }) {
  return {
    prepareCheck: vi.fn(async () => ({ kind: "check", nihoUserId: NIHO_ID } as const)),
    applyStatus: vi.fn(async () => result),
  } as unknown as NihoAccountStatusStore;
}

beforeEach(() => {
  state.config.nihoAccountStatusCheckEnabled = true;
  state.tokenFails = false;
});

afterEach(() => vi.unstubAllGlobals());

describe("NIHO account status check", () => {
  it("keeps the session usable and unstamped when NIHO or its service identity is unavailable", async () => {
    const store = fakeStore();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("NIHO is unavailable"); }));
    expect(await checkNihoAccountStatusSession("host", "s".repeat(43), store)).toBe(true);
    expect(store.prepareCheck).toHaveBeenCalledTimes(1);
    expect(store.applyStatus).not.toHaveBeenCalled();

    state.tokenFails = true;
    expect(await checkNihoAccountStatusSession("traveler", "t".repeat(43), store)).toBe(true);
    expect(store.applyStatus).not.toHaveBeenCalled();
  });

  it("ends the current session when NIHO confirms it is inactive", async () => {
    const store = fakeStore({ kind: "ended", conflicts: [] });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ results: [{ nihoUserId: NIHO_ID, status: "inactive", currentUserId: null }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })));
    expect(await checkNihoAccountStatusSession("host", "s".repeat(43), store)).toBe(false);
    expect(store.applyStatus).toHaveBeenCalledWith(expect.objectContaining({
      kind: "host",
      nihoUserId: NIHO_ID,
      result: { status: "inactive" },
    }));
  });
});
