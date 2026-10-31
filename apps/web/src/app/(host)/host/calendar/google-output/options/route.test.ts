import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  enabled: true,
  access: "OWNER" as "OWNER" | "COHOST" | "OPERATOR",
  get: vi.fn(),
  pool: {},
}));

vi.mock("@/lib/experience/calendar-actor", () => ({
  calendarActor: async () => mocks.access === "OPERATOR"
    ? { actor: { providerId: "provider-a", nihoUserId: "operator-a", calendarScope: "OPERATOR" }, access: { kind: "OPERATOR" } }
    : {
      actor: { providerId: "provider-a", nihoUserId: "owner-a", calendarRoleCeiling: mocks.access === "OWNER" ? "OWNER" : "EDITOR" },
      access: { kind: "MEMBER", nihoRole: mocks.access },
    },
}));
vi.mock("@/lib/experience/google-channel-activation", () => ({
  googleChannelActivationEnabled: () => mocks.enabled,
}));
vi.mock("@niho-experience/experience-store", async () => {
  const actual = await vi.importActual<typeof import("@niho-experience/experience-store")>("@niho-experience/experience-store");
  return { ...actual, GoogleChannelOptionsRepository: class { get = mocks.get; } };
});
vi.mock("@/lib/experience/store-server", () => ({ experiencePool: () => mocks.pool }));
vi.mock("@/lib/host/server", () => ({
  hostNotFound: () => new Response(null, { status: 404 }),
  noStoreJson: (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "private, no-store" } }),
}));

import * as route from "./route";

const base = "https://experience.example/host/calendar/google-output/options";
const valid = `${base}?providerId=provider-a&productId=tea&occurrenceId=rule-a%402099-01-01`;

describe("OWNER Google output options route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.enabled = true;
    mocks.access = "OWNER";
    mocks.get.mockResolvedValue({ connected: false, candidates: [{
      listingId: "listing-a", accountDisplayName: "合成アカウント", mappingVersion: 2,
      desiredVersion: 7, localDate: "2099-01-01", sourceStartAtUtc: "2099-01-01T01:00:00.000Z",
      sourceEndAtUtc: "2099-01-01T02:00:00.000Z", externalProductId: "must-not-leak",
      pendingSetup: { commandId: "00000000-0000-4000-8000-000000000317", expectedMappingVersion: 2, token: "must-not-leak" },
    }] });
  });

  it("is GET-only and hidden while the activation gate is off", async () => {
    expect("POST" in route).toBe(false);
    mocks.enabled = false;
    expect((await route.GET(new NextRequest(valid))).status).toBe(404);
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("rejects missing, duplicate, unknown, and oversized query input", async () => {
    const invalid = [
      `${base}?providerId=provider-a&productId=tea`,
      `${valid}&productId=other`,
      `${valid}&listingId=listing-a`,
      `${base}?providerId=provider-a&productId=${"x".repeat(257)}&occurrenceId=rule-a%402099-01-01`,
    ];
    for (const url of invalid) expect((await route.GET(new NextRequest(url))).status).toBe(400);
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("requires a current MEMBER OWNER and returns a no-store selected projection", async () => {
    mocks.access = "COHOST";
    expect((await route.GET(new NextRequest(valid))).status).toBe(403);
    mocks.access = "OPERATOR";
    expect((await route.GET(new NextRequest(valid))).status).toBe(403);
    mocks.access = "OWNER";
    const response = await route.GET(new NextRequest(valid));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mocks.get).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: "provider-a", nihoUserId: "owner-a" }),
      "tea", "rule-a@2099-01-01",
    );
    expect(JSON.stringify(await response.json())).not.toContain("must-not-leak");
  });
});
