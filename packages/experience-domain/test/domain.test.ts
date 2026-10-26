import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DomainValidationError,
  createBookingOccurrenceSnapshot,
  evaluateAvailability,
  expandOccurrences,
  occurrenceIdFor,
  parseBusyIntervals,
  parseOccurrenceOverrides,
  parseScheduleRule,
  tokyoLocalToUtc,
  type AvailabilityInput,
  type Occurrence,
  type ScheduleRule,
} from "../src/index.ts";

const baseRule: ScheduleRule = {
  id: "tea-ceremony-am",
  timeZone: "Asia/Tokyo",
  startsOn: "2026-11-01",
  localStartTime: "10:00",
  durationMinutes: 90,
  capacity: 6,
  bookingCutoffMinutes: 120,
  busyBufferBeforeMinutes: 30,
  busyBufferAfterMinutes: 15,
  recurrence: { kind: "DAILY" },
};

function occurrence(overrides: Partial<Occurrence> = {}): Occurrence {
  return {
    ...expandOccurrences({ rule: baseRule, fromDate: "2026-11-01", toDate: "2026-11-01" })[0]!,
    ...overrides,
  };
}

function availability(overrides: Partial<AvailabilityInput> = {}): AvailabilityInput {
  return {
    occurrence: occurrence(),
    requestedSeats: 1,
    confirmedSeats: 0,
    heldSeats: 0,
    nowUtc: "2026-10-31T00:00:00.000Z",
    googleCalendar: { blockingEnabled: false, syncStatus: "FRESH", busyIntervals: [] },
    ...overrides,
  };
}

describe("schedule expansion", () => {
  it("expands daily and weekly rules using inclusive Tokyo dates", () => {
    const daily = expandOccurrences({ rule: baseRule, fromDate: "2026-11-01", toDate: "2026-11-04" });
    assert.deepEqual(
      daily.map((item) => item.localDate),
      ["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04"],
    );
    assert.equal(daily[0]?.startUtc, "2026-11-01T01:00:00.000Z");
    const weekly = expandOccurrences({
      rule: { ...baseRule, recurrence: { kind: "WEEKLY" } },
      fromDate: "2026-11-01",
      toDate: "2026-11-15",
    });
    assert.deepEqual(
      weekly.map((item) => item.localDate),
      ["2026-11-01", "2026-11-08", "2026-11-15"],
    );
  });

  it("expands weekends and selected weekdays", () => {
    const weekends = expandOccurrences({
      rule: { ...baseRule, startsOn: "2026-11-02", recurrence: { kind: "WEEKENDS" } },
      fromDate: "2026-11-02",
      toDate: "2026-11-09",
    });
    assert.deepEqual(
      weekends.map((item) => item.localDate),
      ["2026-11-07", "2026-11-08"],
    );
    const selected = expandOccurrences({
      rule: {
        ...baseRule,
        startsOn: "2026-11-02",
        recurrence: { kind: "SELECTED_WEEKDAYS", weekdays: ["MONDAY", "THURSDAY"] },
      },
      fromDate: "2026-11-02",
      toDate: "2026-11-09",
    });
    assert.deepEqual(
      selected.map((item) => item.localDate),
      ["2026-11-02", "2026-11-05", "2026-11-09"],
    );
  });

  it("shows a moved occurrence in its actual calendar range", () => {
    const movedId = occurrenceIdFor(baseRule.id, "2026-11-01");
    const overrides = [{ occurrenceId: movedId, kind: "RESCHEDULE", localDate: "2026-11-04", localStartTime: "13:00" }] as const;
    const originalRange = expandOccurrences({ rule: baseRule, overrides, fromDate: "2026-11-01", toDate: "2026-11-01" });
    assert.equal(originalRange.length, 0);
    const newRange = expandOccurrences({ rule: baseRule, overrides, fromDate: "2026-11-04", toDate: "2026-11-04" });
    assert.equal(newRange.some((item) => item.id === movedId), true);
  });

  it("closes or reschedules one occurrence without changing its stable identity", () => {
    const closeId = occurrenceIdFor(baseRule.id, "2026-11-02");
    const moveId = occurrenceIdFor(baseRule.id, "2026-11-03");
    const expanded = expandOccurrences({
      rule: baseRule,
      fromDate: "2026-11-01",
      toDate: "2026-11-05",
      overrides: [
        { occurrenceId: closeId, kind: "CLOSE" },
        {
          occurrenceId: moveId,
          kind: "RESCHEDULE",
          localDate: "2026-11-05",
          localStartTime: "14:30",
          durationMinutes: 120,
        },
      ],
    });
    assert.equal(expanded.find((item) => item.id === closeId)?.status, "CLOSED");
    assert.deepEqual(
      {
        id: expanded.find((item) => item.id === moveId)?.id,
        sourceLocalDate: expanded.find((item) => item.id === moveId)?.sourceLocalDate,
        localDate: expanded.find((item) => item.id === moveId)?.localDate,
        localStartTime: expanded.find((item) => item.id === moveId)?.localStartTime,
        startUtc: expanded.find((item) => item.id === moveId)?.startUtc,
        endUtc: expanded.find((item) => item.id === moveId)?.endUtc,
        rescheduled: expanded.find((item) => item.id === moveId)?.rescheduled,
      },
      {
        id: moveId,
        sourceLocalDate: "2026-11-03",
        localDate: "2026-11-05",
        localStartTime: "14:30",
        startUtc: "2026-11-05T05:30:00.000Z",
        endUtc: "2026-11-05T07:30:00.000Z",
        rescheduled: true,
      },
    );
  });

  it("keeps an accepted booking snapshot independent from later rule edits", () => {
    const original = occurrence();
    const snapshot = createBookingOccurrenceSnapshot(original, 2, "2026-10-30T00:00:00.000Z");
    const edited = expandOccurrences({
      rule: { ...baseRule, localStartTime: "18:00", capacity: 3 },
      fromDate: "2026-11-01",
      toDate: "2026-11-01",
    })[0]!;
    assert.equal(edited.id, original.id);
    assert.equal(snapshot.startUtc, "2026-11-01T01:00:00.000Z");
    assert.equal(snapshot.capacityAtAcceptance, 6);
    assert.equal(snapshot.seats, 2);
  });
});

describe("availability", () => {
  it("treats buffered overlap as busy but allows exact adjacency", () => {
    const blocked = evaluateAvailability(
      availability({
        googleCalendar: {
          blockingEnabled: true,
          syncStatus: "FRESH",
          busyIntervals: [{ startUtc: "2026-11-01T00:45:00.000Z", endUtc: "2026-11-01T00:46:00.000Z" }],
        },
      }),
    );
    assert.deepEqual(
      { bookable: blocked.bookable, reason: blocked.reason, availableSeats: blocked.availableSeats },
      { bookable: false, reason: "GOOGLE_BUSY", availableSeats: 0 },
    );

    const adjacentBefore = evaluateAvailability(
      availability({
        googleCalendar: {
          blockingEnabled: true,
          syncStatus: "FRESH",
          busyIntervals: [{ startUtc: "2026-10-31T23:00:00.000Z", endUtc: "2026-11-01T00:30:00.000Z" }],
        },
      }),
    );
    const adjacentAfter = evaluateAvailability(
      availability({
        googleCalendar: {
          blockingEnabled: true,
          syncStatus: "FRESH",
          busyIntervals: [{ startUtc: "2026-11-01T02:45:00.000Z", endUtc: "2026-11-01T03:00:00.000Z" }],
        },
      }),
    );
    assert.equal(adjacentBefore.reason, "AVAILABLE");
    assert.equal(adjacentAfter.reason, "AVAILABLE");
  });

  it("counts active holds and confirmed seats without cancelling confirmed bookings", () => {
    const capacity = evaluateAvailability(availability({ requestedSeats: 2, confirmedSeats: 3, heldSeats: 2 }));
    assert.deepEqual(
      {
        bookable: capacity.bookable,
        reason: capacity.reason,
        availableSeats: capacity.availableSeats,
        remainingCapacity: capacity.remainingCapacity,
        confirmedSeats: capacity.confirmedSeats,
      },
      {
        bookable: false,
        reason: "INSUFFICIENT_CAPACITY",
        availableSeats: 1,
        remainingCapacity: 1,
        confirmedSeats: 3,
      },
    );
    const busyWithConfirmed = evaluateAvailability(
      availability({
        confirmedSeats: 3,
        googleCalendar: {
          blockingEnabled: true,
          syncStatus: "FRESH",
          busyIntervals: [{ startUtc: "2026-11-01T01:00:00.000Z", endUtc: "2026-11-01T01:30:00.000Z" }],
        },
      }),
    );
    assert.equal(busyWithConfirmed.reason, "GOOGLE_BUSY");
    assert.equal(busyWithConfirmed.confirmedSeats, 3);
    assert.equal(busyWithConfirmed.remainingCapacity, 3);
  });

  for (const syncStatus of ["STALE", "FAILED"] as const) {
    it(`fails closed for ${syncStatus} Google sync when blocking is enabled`, () => {
      const enabled = evaluateAvailability(
        availability({ googleCalendar: { blockingEnabled: true, syncStatus, busyIntervals: [] } }),
      );
      assert.equal(enabled.bookable, false);
      assert.equal(enabled.reason, "GOOGLE_SYNC_UNAVAILABLE");
      assert.equal(enabled.availableSeats, 0);
      assert.equal(
        evaluateAvailability(
          availability({ googleCalendar: { blockingEnabled: false, syncStatus, busyIntervals: [] } }),
        ).reason,
        "AVAILABLE",
      );
    });
  }

  it("honors manual closure and the booking cutoff", () => {
    assert.equal(
      evaluateAvailability(availability({ occurrence: occurrence({ status: "CLOSED" }) })).reason,
      "MANUALLY_CLOSED",
    );
    assert.equal(
      evaluateAvailability(availability({ nowUtc: "2026-10-31T23:00:00.000Z" })).reason,
      "BOOKING_CUTOFF_REACHED",
    );
  });
});

describe("validation boundaries", () => {
  it("validates Tokyo time zone, real dates, ranges, and weekday sets", () => {
    assert.throws(() => parseScheduleRule({ ...baseRule, timeZone: "UTC" }), DomainValidationError);
    assert.throws(() => parseScheduleRule({ ...baseRule, startsOn: "2026-02-30" }), DomainValidationError);
    assert.throws(() => parseScheduleRule({ ...baseRule, capacity: 0 }), DomainValidationError);
    assert.throws(
      () =>
        parseScheduleRule({
          ...baseRule,
          recurrence: { kind: "SELECTED_WEEKDAYS", weekdays: ["MONDAY", "MONDAY"] },
        }),
      DomainValidationError,
    );
    assert.equal(tokyoLocalToUtc("2026-11-01", "00:00"), "2026-10-31T15:00:00.000Z");
  });

  it("validates overrides and accepts only time boundaries for busy intervals", () => {
    assert.throws(
      () =>
        parseOccurrenceOverrides([
          { occurrenceId: "same", kind: "CLOSE" },
          { occurrenceId: "same", kind: "CLOSE" },
        ]),
      DomainValidationError,
    );
    assert.throws(
      () =>
        parseOccurrenceOverrides([
          { occurrenceId: "id", kind: "RESCHEDULE", localDate: "bad", localStartTime: "25:00" },
        ]),
      DomainValidationError,
    );
    assert.throws(
      () =>
        parseBusyIntervals([
          { startUtc: "2026-11-01T01:00:00.000Z", endUtc: "2026-11-01T01:00:00.000Z" },
        ]),
      DomainValidationError,
    );
    assert.deepEqual(
      parseBusyIntervals([
        {
          startUtc: "2026-11-01T01:00:00.000Z",
          endUtc: "2026-11-01T02:00:00.000Z",
          summary: "must not cross the domain boundary",
        },
      ]),
      [{ startUtc: "2026-11-01T01:00:00.000Z", endUtc: "2026-11-01T02:00:00.000Z" }],
    );
  });

  it("allows exactly 90 inclusive days and rejects 91", () => {
    assert.equal(
      expandOccurrences({ rule: baseRule, fromDate: "2026-11-01", toDate: "2027-01-29" }).length,
      90,
    );
    assert.throws(
      () => expandOccurrences({ rule: baseRule, fromDate: "2026-11-01", toDate: "2027-01-30" }),
      /must not exceed 90/,
    );
  });
});
