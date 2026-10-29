import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@niho-experience/experience-store", async () => {
  const actual = await vi.importActual<typeof import("@niho-experience/experience-store")>("@niho-experience/experience-store");
  return { ...actual, evaluateStoredInventories: vi.fn(async (_pool, _providerId, requests: readonly { occurrence: { id: string } }[]) => new Map(requests.map((request) => [request.occurrence.id, { availability: { bookable: false, reason: "INSUFFICIENT_CAPACITY", availableSeats: 0 } }]))) };
});

import { readHostCalendar } from "./calendar-read";

describe("operator calendar read model", () => {
  it("uses reservation data only for canReschedule and omits counts, free seats, busy intervals, and Google identity", async () => {
    const rule = { id: "rule-a", timeZone: "Asia/Tokyo" as const, startsOn: "2099-01-01", endsOn: "2099-01-01", localStartTime: "10:00", durationMinutes: 60,
      capacity: 4, bookingCutoffMinutes: 0, busyBufferBeforeMinutes: 0, busyBufferAfterMinutes: 0, recurrence: { kind: "WEEKLY" as const } };
    const store = {
      listCalendarProducts: vi.fn().mockResolvedValue([{ id: "tea", publicTitle: "Synthetic tea", sellerDisplayName: "Synthetic seller", access: { basis: "OPERATOR", version: 1, assignmentLabel: "Teacher" } }]),
      listSchedule: vi.fn().mockResolvedValue([{ rule: { providerId: "provider-a", productId: "tea", rule, version: 1 }, overrides: [], salesStates: [] }]),
      verifyActiveMembership: vi.fn(), getGoogleCalendar: vi.fn(),
    };
    const pool = { query: vi.fn().mockImplementation(async (sql: string) => sql.includes("FROM bookings")
      ? { rows: [{ occurrence_id: "rule-a@2099-01-01", confirmed_seats: "2", held_seats: "0" }] } : { rows: [] }) };
    const data = await readHostCalendar(pool as never, store as never, { providerId: "provider-a", nihoUserId: "operator-a" }, "2099-01-01", "2099-01-01");
    expect(data.scope).toBe("OPERATOR");
    expect(data.busyIntervals).toEqual([]);
    expect(data.google).toEqual({ connected: false, canManage: false, blockingEnabled: false, syncStatus: "STALE" });
    expect(store.getGoogleCalendar).not.toHaveBeenCalled();
    expect(data.occurrences[0]).toMatchObject({ experienceId: "tea", canReschedule: false, availabilityReason: "INSUFFICIENT_CAPACITY" });
    expect(data.occurrences[0]).not.toHaveProperty("confirmedSeats");
    expect(data.occurrences[0]).not.toHaveProperty("heldSeats");
    expect(data.occurrences[0]).not.toHaveProperty("availableSeats");
    expect(JSON.stringify(data)).not.toMatch(/opaque|calendarId|externalAccount/i);
  });
});
