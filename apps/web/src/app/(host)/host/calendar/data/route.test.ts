import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  role: "OWNER" as "OWNER" | "EDITOR" | "VIEWER",
  saveRule: vi.fn(),
  reschedule: vi.fn(),
  salesState: vi.fn(),
  poolQuery: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: { hostConsoleEnabled: true } }));
vi.mock("@/lib/experience/host-actor", () => ({ hostActor: async () => ({ actor: { providerId: "provider-1", nihoUserId: "user-1" }, nihoRole: mocks.role }) }));
vi.mock("@/lib/experience/store-server", () => ({
  experiencePool: () => ({ query: mocks.poolQuery }),
  experienceStore: () => ({ saveScheduleRule: mocks.saveRule, saveOccurrenceOverride: mocks.reschedule, setOccurrenceSalesState: mocks.salesState }),
}));
vi.mock("@/lib/experience/google-connection", () => ({ syncGoogleBusy: vi.fn() }));
vi.mock("@/lib/experience/calendar-read", () => ({ readHostCalendar: vi.fn() }));
vi.mock("@/lib/host/relay", () => ({ mutationFromSameOrigin: () => true }));
vi.mock("@/lib/host/server", () => ({
  hostNotFound: () => new Response(null, { status: 404 }),
  isHostMock: () => false,
  noStoreJson: (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "private, no-store" } }),
  siteOrigin: () => "https://experience.example",
}));

import { POST } from "./route";

const COMMAND = "00000000-0000-4000-8000-000000000111";
const request = (body: unknown) => new NextRequest("https://experience.example/host/calendar/data", {
  method: "POST",
  headers: { origin: "https://experience.example", "sec-fetch-site": "same-origin", "content-type": "application/json" },
  body: JSON.stringify({ providerId: "provider-1", ...body as object }),
});

describe("host calendar mutation route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.role = "OWNER";
    mocks.poolQuery.mockResolvedValue({ rows: [{ product_id: "experience-1" }] });
    mocks.saveRule.mockResolvedValue({ aggregateId: COMMAND, version: 1, repeated: false });
    mocks.reschedule.mockResolvedValue({ aggregateId: "rule-1@2099-01-01", version: 2, repeated: false });
    mocks.salesState.mockResolvedValue({ aggregateId: "rule-1@2099-01-01", version: 3, repeated: false });
  });

  it("keeps NIHO VIEWER read-only before touching the Experience store", async () => {
    mocks.role = "VIEWER";
    const response = await POST(request({ action: "setSalesState", commandId: COMMAND, occurrenceId: "rule-1@2099-01-01", expectedVersion: null, desiredState: "CLOSED" }));
    expect(response.status).toBe(403);
    expect(mocks.salesState).not.toHaveBeenCalled();
  });

  it("uses the browser UUID as both create identity and idempotency command", async () => {
    const body = { action: "createRule", commandId: COMMAND, experienceId: "experience-1", rule: { timeZone: "Asia/Tokyo", startsOn: "2099-01-01", endsOn: "2099-01-01", localStartTime: "10:00", durationMinutes: 60, capacity: 4, bookingCutoffMinutes: 120, busyBufferBeforeMinutes: 0, busyBufferAfterMinutes: 0, recurrence: { kind: "WEEKLY" } } };
    expect((await POST(request(body))).status).toBe(201);
    expect(mocks.saveRule).toHaveBeenCalledWith(expect.anything(), "experience-1", expect.objectContaining({ id: COMMAND }), null, COMMAND);
    mocks.saveRule.mockResolvedValue({ aggregateId: COMMAND, version: 1, repeated: true });
    expect((await POST(request(body))).status).toBe(200);
  });

  it("routes reopen to the orthogonal sales state and leaves timing untouched", async () => {
    const response = await POST(request({ action: "setSalesState", commandId: COMMAND, occurrenceId: "rule-1@2099-01-01", expectedVersion: 2, desiredState: "OPEN" }));
    expect(response.status).toBe(200);
    expect(mocks.salesState).toHaveBeenCalledWith(expect.anything(), "experience-1", "rule-1", { occurrenceId: "rule-1@2099-01-01", desiredState: "OPEN" }, 2, COMMAND);
    expect(mocks.reschedule).not.toHaveBeenCalled();
  });

  it("rejects missing or non-v4 commands", async () => {
    expect((await POST(request({ action: "createRule", experienceId: "experience-1", rule: {} }))).status).toBe(400);
    expect((await POST(request({ action: "createRule", commandId: "not-a-uuid", experienceId: "experience-1", rule: {} }))).status).toBe(400);
    expect(mocks.saveRule).not.toHaveBeenCalled();
  });
});
