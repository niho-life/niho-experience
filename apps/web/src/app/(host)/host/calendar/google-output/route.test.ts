import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  enabled: true,
  access: "OWNER" as "OWNER" | "EDITOR" | "OPERATOR",
  execute: vi.fn(),
  get: vi.fn(),
  pool: { synthetic: true },
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/experience/calendar-actor", () => ({
  calendarActor: async () => mocks.access === "OPERATOR"
    ? { actor: { providerId: "provider-a", nihoUserId: "operator-a", calendarScope: "OPERATOR" }, access: { kind: "OPERATOR", assignments: [] } }
    : { actor: { providerId: "provider-a", nihoUserId: "owner-a", calendarRoleCeiling: mocks.access === "OWNER" ? "OWNER" : "EDITOR" }, access: { kind: "MEMBER", nihoRole: mocks.access } },
}));
vi.mock("@/lib/experience/google-channel-setup", () => ({
  googleChannelSetupEnabled: () => mocks.enabled,
  executeGoogleChannelSetup: mocks.execute,
  googleChannelSetupDto: (value: Record<string, unknown>) => ({
    commandId: value.commandId, listingId: value.listingId, state: value.state, calendarName: value.calendarName,
    ...(value.reason ? { reason: value.reason } : {}),
  }),
}));
vi.mock("@niho-experience/experience-store", async () => {
  const actual = await vi.importActual<typeof import("@niho-experience/experience-store")>("@niho-experience/experience-store");
  return { ...actual, GoogleChannelSetupRepository: class { get = mocks.get; } };
});
vi.mock("@/lib/experience/store-server", () => ({ experiencePool: () => mocks.pool }));
vi.mock("@/lib/host/relay", () => ({
  mutationFromSameOrigin: (_method: string, headers: Headers) => headers.get("origin") === "https://experience.example" && headers.get("sec-fetch-site") === "same-origin",
}));
vi.mock("@/lib/host/server", () => ({
  hostNotFound: () => new Response(null, { status: 404 }), siteOrigin: () => "https://experience.example",
  noStoreJson: (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "private, no-store" } }),
}));

import { GET, POST } from "./route";

const commandId = "00000000-0000-4000-8000-000000000123";
const input = { providerId: "provider-a", listingId: "listing-a", expectedMappingVersion: 1, commandId };
const post = (body: unknown, url = "https://experience.example/host/calendar/google-output", headers: Record<string, string> = {}) => new NextRequest(url, {
  method: "POST",
  headers: { origin: "https://experience.example", "sec-fetch-site": "same-origin", "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

describe("OWNER Google output setup route", () => {
  beforeEach(() => {
    vi.clearAllMocks(); mocks.enabled = true; mocks.access = "OWNER";
    const selected = {
      commandId, listingId: "listing-a", state: "READY_FOR_CONNECTION", calendarName: "NIHO Airbnb | Synthetic",
      operationNonce: "must-not-leak", calendarId: "must-not-leak", encryptedRefreshToken: "must-not-leak", grantedScopes: ["must-not-leak"],
    };
    mocks.execute.mockResolvedValue(selected);
    mocks.get.mockResolvedValue(selected);
  });

  it("is default-off/mock-closed before identity, DB, or body handling", async () => {
    mocks.enabled = false;
    expect((await GET(new NextRequest("https://experience.example/host/calendar/google-output?providerId=provider-a&listingId=listing-a"))).status).toBe(404);
    expect((await POST(post(input))).status).toBe(404);
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("requires same-origin JSON and the exact bounded request/query shape", async () => {
    expect((await POST(post(input, "https://experience.example/host/calendar/google-output?calendarId=untrusted"))).status).toBe(400);
    expect((await POST(post(input, undefined, { origin: "https://evil.example", "sec-fetch-site": "cross-site" }))).status).toBe(403);
    expect((await POST(post(input, undefined, { "content-type": "text/plain" }))).status).toBe(415);
    for (const body of [
      { ...input, calendarId: "untrusted" },
      { ...input, summary: "untrusted" },
      { ...input, token: "untrusted" },
      { ...input, actorId: "untrusted" },
      { ...input, commandId: "not-a-v4" },
    ]) expect((await POST(post(body))).status).toBe(400);
    expect((await POST(post({ ...input, summary: "x".repeat(9_000) }))).status).toBe(413);
    expect((await GET(new NextRequest("https://experience.example/host/calendar/google-output?providerId=provider-a&listingId=listing-a&calendarId=x"))).status).toBe(400);
    expect((await GET(new NextRequest("https://experience.example/host/calendar/google-output?providerId=provider-a&providerId=provider-b&listingId=listing-a"))).status).toBe(400);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("rejects EDITOR and OPERATOR before setup execution", async () => {
    mocks.access = "EDITOR";
    expect((await POST(post(input))).status).toBe(403);
    mocks.access = "OPERATOR";
    expect((await POST(post(input))).status).toBe(403);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("passes only server-authorized input and explicitly selects the secret-free DTO", async () => {
    const response = await POST(post(input));
    expect(response.status).toBe(200);
    expect(mocks.execute).toHaveBeenCalledWith(
      mocks.pool,
      expect.objectContaining({ providerId: "provider-a", nihoUserId: "owner-a", calendarRoleCeiling: "OWNER" }),
      { listingId: "listing-a", expectedMappingVersion: 1, commandId },
    );
    expect(await response.json()).toEqual({ commandId, listingId: "listing-a", state: "READY_FOR_CONNECTION", calendarName: "NIHO Airbnb | Synthetic" });
    const get = await GET(new NextRequest("https://experience.example/host/calendar/google-output?providerId=provider-a&listingId=listing-a"));
    expect(await get.json()).toEqual({ commandId, listingId: "listing-a", state: "READY_FOR_CONNECTION", calendarName: "NIHO Airbnb | Synthetic" });
  });
});
