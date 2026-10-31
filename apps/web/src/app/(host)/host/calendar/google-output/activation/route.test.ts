import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  enabled: true,
  access: "OWNER" as "OWNER" | "COHOST" | "OPERATOR",
  activate: vi.fn(),
  get: vi.fn(),
  pool: { synthetic: true },
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/experience/calendar-actor", () => ({
  calendarActor: async () => mocks.access === "OPERATOR"
    ? { actor: { providerId: "provider-a", nihoUserId: "operator-a", calendarScope: "OPERATOR" }, access: { kind: "OPERATOR", assignments: [] } }
    : { actor: { providerId: "provider-a", nihoUserId: "owner-a", calendarRoleCeiling: mocks.access === "OWNER" ? "OWNER" : "VIEWER" }, access: { kind: "MEMBER", nihoRole: mocks.access } },
}));
vi.mock("@/lib/experience/google-channel-activation", () => ({
  googleChannelActivationEnabled: () => mocks.enabled,
  executeGoogleChannelActivation: mocks.activate,
  googleChannelActivationAppliedDto: (value: Record<string, unknown>) => ({
    commandId: value.commandId, listingId: value.listingId, occurrenceId: value.occurrenceId, state: value.state,
  }),
  googleChannelActivationStatusDto: (value: Record<string, unknown>) => ({
    listingId: value.listingId, occurrenceId: value.occurrenceId, state: value.state,
    expectedMappingVersion: value.expectedMappingVersion, expectedBindingVersion: value.expectedBindingVersion,
    expectedDesiredVersion: value.expectedDesiredVersion,
  }),
}));
vi.mock("@niho-experience/experience-store", async () => {
  const actual = await vi.importActual<typeof import("@niho-experience/experience-store")>("@niho-experience/experience-store");
  return { ...actual, GoogleChannelActivationRepository: class { get = mocks.get; } };
});
vi.mock("@/lib/experience/store-server", () => ({ experiencePool: () => mocks.pool }));
vi.mock("@/lib/host/relay", () => ({
  mutationFromSameOrigin: (_method: string, headers: Headers) => headers.get("origin") === "https://experience.example"
    && headers.get("sec-fetch-site") === "same-origin",
}));
vi.mock("@/lib/host/server", () => ({
  hostNotFound: () => new Response(null, { status: 404 }), siteOrigin: () => "https://experience.example",
  noStoreJson: (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "private, no-store" } }),
}));

import { GET, POST } from "./route";

const commandId = "00000000-0000-4000-8000-000000000315";
const input = {
  providerId: "provider-a", listingId: "listing-a", occurrenceId: "rule-a@2099-01-01",
  expectedMappingVersion: 3, expectedBindingVersion: 5, expectedDesiredVersion: 7,
  commandId, connectionConfirmed: true,
};
const url = "https://experience.example/host/calendar/google-output/activation";
const post = (body: unknown, target = url, headers: Record<string, string> = {}) => new NextRequest(target, {
  method: "POST",
  headers: { origin: "https://experience.example", "sec-fetch-site": "same-origin", "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

describe("OWNER Google output activation route", () => {
  beforeEach(() => {
    vi.clearAllMocks(); mocks.enabled = true; mocks.access = "OWNER";
    mocks.activate.mockResolvedValue({ commandId, listingId: input.listingId, occurrenceId: input.occurrenceId, state: "APPLIED", calendarId: "must-not-leak" });
    mocks.get.mockResolvedValue({
      listingId: input.listingId, occurrenceId: input.occurrenceId, state: "READY",
      expectedMappingVersion: 3, expectedBindingVersion: 5, expectedDesiredVersion: 7,
      token: "must-not-leak", calendarId: "must-not-leak",
    });
  });

  it("stays closed unless both server gates are enabled", async () => {
    mocks.enabled = false;
    expect((await POST(post(input))).status).toBe(404);
    expect((await GET(new NextRequest(`${url}?providerId=provider-a&listingId=listing-a&occurrenceId=${encodeURIComponent(input.occurrenceId)}`))).status).toBe(404);
    expect(mocks.activate).not.toHaveBeenCalled();
  });

  it("requires same-origin JSON and rejects query, unknown, privileged, or non-confirmed fields", async () => {
    expect((await POST(post(input, `${url}?state=ACTIVE`))).status).toBe(400);
    expect((await POST(post(input, url, { origin: "https://evil.example", "sec-fetch-site": "cross-site" }))).status).toBe(403);
    expect((await POST(post(input, url, { "content-type": "text/plain" }))).status).toBe(415);
    for (const extra of [{ calendarId: "x" }, { actor: "x" }, { token: "x" }, { state: "ACTIVE" }, { startAtUtc: "x" }]) {
      expect((await POST(post({ ...input, ...extra }))).status).toBe(400);
    }
    expect((await POST(post({ ...input, connectionConfirmed: false }))).status).toBe(400);
    expect((await POST(post({ ...input, commandId: "not-v4" }))).status).toBe(400);
    expect((await POST(post({ ...input, token: "x".repeat(9_000) }))).status).toBe(413);
    expect(mocks.activate).not.toHaveBeenCalled();
  });

  it("denies COHOST and product operators before repository mutation", async () => {
    mocks.access = "COHOST";
    expect((await POST(post(input))).status).toBe(403);
    mocks.access = "OPERATOR";
    expect((await POST(post(input))).status).toBe(403);
    expect(mocks.activate).not.toHaveBeenCalled();
  });

  it("passes only the exact command and returns secret-free no-store projections", async () => {
    const response = await POST(post(input));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mocks.activate).toHaveBeenCalledWith(mocks.pool, expect.objectContaining({ nihoUserId: "owner-a" }), {
      listingId: input.listingId, occurrenceId: input.occurrenceId, expectedMappingVersion: 3,
      expectedBindingVersion: 5, expectedDesiredVersion: 7, commandId, connectionConfirmed: true,
    });
    expect(await response.json()).toEqual({ commandId, listingId: input.listingId, occurrenceId: input.occurrenceId, state: "APPLIED" });
    const get = await GET(new NextRequest(`${url}?providerId=provider-a&listingId=listing-a&occurrenceId=${encodeURIComponent(input.occurrenceId)}`));
    expect(await get.json()).toEqual({
      listingId: input.listingId, occurrenceId: input.occurrenceId, state: "READY",
      expectedMappingVersion: 3, expectedBindingVersion: 5, expectedDesiredVersion: 7,
    });
  });
});
