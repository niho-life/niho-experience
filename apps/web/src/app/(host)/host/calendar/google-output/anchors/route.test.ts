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
vi.mock("@/lib/experience/google-channel-anchor", () => ({
  googleChannelAnchorEnabled: () => mocks.enabled,
  executeGoogleChannelAnchor: mocks.execute,
  googleChannelAnchorDto: (value: Record<string, unknown>) => ({
    commandId: value.commandId, listingId: value.listingId, occurrenceId: value.occurrenceId, state: value.state,
    ...(value.reason ? { reason: value.reason } : {}),
  }),
}));
vi.mock("@niho-experience/experience-store", async () => {
  const actual = await vi.importActual<typeof import("@niho-experience/experience-store")>("@niho-experience/experience-store");
  return { ...actual, GoogleChannelAnchorRepository: class { get = mocks.get; } };
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

const commandId = "00000000-0000-4000-8000-000000000278";
const occurrenceId = "rule-a@2030-01-01";
const input = {
  providerId: "provider-a", listingId: "listing-a", occurrenceId,
  expectedMappingVersion: 3, expectedDesiredVersion: 7, commandId, operation: "initialize",
};
const endpoint = "https://experience.example/host/calendar/google-output/anchors";
const post = (body: unknown, url = endpoint, headers: Record<string, string> = {}) => new NextRequest(url, {
  method: "POST",
  headers: { origin: "https://experience.example", "sec-fetch-site": "same-origin", "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

describe("OWNER Google anchor route", () => {
  beforeEach(() => {
    vi.clearAllMocks(); mocks.enabled = true; mocks.access = "OWNER";
    const selected = {
      commandId, listingId: "listing-a", occurrenceId, state: "GOOGLE_VERIFIED",
      eventId: "must-not-leak", etag: "must-not-leak", calendarId: "must-not-leak",
      operationNonce: "must-not-leak", token: "must-not-leak",
    };
    mocks.execute.mockResolvedValue(selected);
    mocks.get.mockResolvedValue(selected);
  });

  it("is default-off before identity, DB, or body handling", async () => {
    mocks.enabled = false;
    expect((await GET(new NextRequest(`${endpoint}?providerId=provider-a&listingId=listing-a&occurrenceId=${encodeURIComponent(occurrenceId)}`))).status).toBe(404);
    expect((await POST(post(input))).status).toBe(404);
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("requires same-origin JSON and exact bounded fields/query", async () => {
    expect((await POST(post(input, `${endpoint}?calendarId=x`))).status).toBe(400);
    expect((await POST(post(input, endpoint, { origin: "https://evil.example", "sec-fetch-site": "cross-site" }))).status).toBe(403);
    expect((await POST(post(input, endpoint, { "content-type": "text/plain" }))).status).toBe(415);
    for (const body of [
      { ...input, calendarId: "untrusted" }, { ...input, token: "untrusted" }, { ...input, actorId: "untrusted" },
      { ...input, commandId: "not-v4" }, { ...input, operation: "retry" }, { ...input, expectedDesiredVersion: 0 },
    ]) expect((await POST(post(body))).status).toBe(400);
    expect((await POST(post({ ...input, token: "x".repeat(9_000) }))).status).toBe(413);
    expect((await GET(new NextRequest(`${endpoint}?providerId=provider-a&listingId=listing-a&occurrenceId=${encodeURIComponent(occurrenceId)}&calendarId=x`))).status).toBe(400);
    expect((await GET(new NextRequest(`${endpoint}?providerId=provider-a&providerId=provider-b&listingId=listing-a&occurrenceId=${encodeURIComponent(occurrenceId)}`))).status).toBe(400);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("rejects EDITOR and OPERATOR before execution", async () => {
    mocks.access = "EDITOR";
    expect((await POST(post(input))).status).toBe(403);
    mocks.access = "OPERATOR";
    expect((await POST(post(input))).status).toBe(403);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("passes selected authority input and returns only command status", async () => {
    const response = await POST(post(input));
    expect(response.status).toBe(200);
    expect(mocks.execute).toHaveBeenCalledWith(
      mocks.pool,
      expect.objectContaining({ providerId: "provider-a", nihoUserId: "owner-a", calendarRoleCeiling: "OWNER" }),
      {
        listingId: "listing-a", occurrenceId, expectedMappingVersion: 3,
        expectedDesiredVersion: 7, commandId, operation: "initialize",
      },
    );
    expect(await response.json()).toEqual({ commandId, listingId: "listing-a", occurrenceId, state: "GOOGLE_VERIFIED" });
    const get = await GET(new NextRequest(`${endpoint}?providerId=provider-a&listingId=listing-a&occurrenceId=${encodeURIComponent(occurrenceId)}`));
    expect(await get.json()).toEqual({ commandId, listingId: "listing-a", occurrenceId, state: "GOOGLE_VERIFIED" });
  });
});
