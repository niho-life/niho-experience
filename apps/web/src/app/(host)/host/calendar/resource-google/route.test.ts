import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  role: "OWNER" as "OWNER" | "OPERATOR",
  save: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: { hostConsoleEnabled: true } }));
vi.mock("@/lib/experience/calendar-actor", () => ({ calendarActor: async () => mocks.role === "OWNER"
  ? { actor: { providerId: "provider-a", nihoUserId: "owner-a", calendarRoleCeiling: "OWNER" }, access: { kind: "MEMBER", nihoRole: "OWNER" } }
  : { actor: { providerId: "provider-a", nihoUserId: "operator-a", calendarScope: "OPERATOR" }, access: { kind: "OPERATOR", assignments: [] } } }));
vi.mock("@/lib/experience/resource-google", () => ({ resourceGoogleEnabled: () => true, refreshResourceGoogleOwnerSnapshot: mocks.refresh }));
vi.mock("@niho-experience/experience-store", async () => {
  const actual = await vi.importActual<typeof import("@niho-experience/experience-store")>("@niho-experience/experience-store");
  return { ...actual, ResourceGoogleRepository: class { save = mocks.save; } };
});
vi.mock("@/lib/experience/store-server", () => ({ experiencePool: () => ({}) }));
vi.mock("@/lib/host/relay", () => ({ mutationFromSameOrigin: (_method: string, headers: Headers) => headers.get("origin") === "https://experience.example" && headers.get("sec-fetch-site") === "same-origin" }));
vi.mock("@/lib/host/server", () => ({
  hostNotFound: () => new Response(null, { status: 404 }), isHostMock: () => false, siteOrigin: () => "https://experience.example",
  noStoreJson: (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "private, no-store" } }),
}));

import { GET, PUT } from "./route";

const commandId = "00000000-0000-4000-8000-000000000123";
const input = { providerId: "provider-a", resourceId: "room-a", calendarId: "private", enabled: true, expectedVersion: null, commandId };
const put = (body: unknown, headers: Record<string, string> = {}) => new NextRequest("https://experience.example/host/calendar/resource-google", {
  method: "PUT", headers: { origin: "https://experience.example", "sec-fetch-site": "same-origin", "content-type": "application/json", ...headers }, body: JSON.stringify(body),
});

describe("resource Google owner route", () => {
  beforeEach(() => {
    vi.clearAllMocks(); mocks.role = "OWNER";
    mocks.save.mockResolvedValue({ version: 1, repeated: false });
    mocks.refresh.mockResolvedValue({ resources: [], calendars: [], connectionGeneration: 1, inventoryFetchedAtUtc: new Date().toISOString() });
  });

  it("returns server-selected calendars only to a current OWNER", async () => {
    expect((await GET(new NextRequest("https://experience.example/host/calendar/resource-google?providerId=provider-a"))).status).toBe(200);
    mocks.role = "OPERATOR";
    expect((await GET(new NextRequest("https://experience.example/host/calendar/resource-google?providerId=provider-a"))).status).toBe(403);
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it("requires same-origin and rejects OPERATOR before store mutation", async () => {
    expect((await PUT(put(input, { origin: "https://evil.example", "sec-fetch-site": "cross-site" }))).status).toBe(403);
    mocks.role = "OPERATOR";
    expect((await PUT(put(input))).status).toBe(403);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("accepts only the exact bounded command shape", async () => {
    expect((await PUT(put({ ...input, role: "OWNER" }))).status).toBe(400);
    expect((await PUT(put({ ...input, calendarId: "x".repeat(9_000) }))).status).toBe(413);
    expect((await PUT(put(input))).status).toBe(201);
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ calendarRoleCeiling: "OWNER" }), { resourceId: "room-a", calendarId: "private", enabled: true }, null, commandId);
  });
});
