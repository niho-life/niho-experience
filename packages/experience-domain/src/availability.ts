import { EXPERIENCE_TIME_ZONE, type AvailabilityInput, type AvailabilityReason, type AvailabilityResult, type BusyInterval } from "#types";
import { addMinutes } from "#time";
import { DomainValidationError, assertIntegerInRange, assertUtcInstant, parseBusyIntervals } from "#validation";

export function intervalsOverlap(left: BusyInterval, right: BusyInterval): boolean {
  assertUtcInstant(left.startUtc, "left.startUtc");
  assertUtcInstant(left.endUtc, "left.endUtc");
  assertUtcInstant(right.startUtc, "right.startUtc");
  assertUtcInstant(right.endUtc, "right.endUtc");
  if (left.startUtc >= left.endUtc || right.startUtc >= right.endUtc) {
    throw new DomainValidationError(["intervals must have startUtc before endUtc"]);
  }
  return left.startUtc < right.endUtc && right.startUtc < left.endUtc;
}

function result(
  input: AvailabilityInput,
  reason: AvailabilityReason,
  remainingCapacity: number,
): AvailabilityResult {
  const bookable = reason === "AVAILABLE";
  return {
    bookable,
    reason,
    availableSeats: bookable || reason === "INSUFFICIENT_CAPACITY" ? remainingCapacity : 0,
    remainingCapacity,
    confirmedSeats: input.confirmedSeats,
    heldSeats: input.heldSeats,
  };
}

export function evaluateAvailability(input: AvailabilityInput): AvailabilityResult {
  assertIntegerInRange(input.requestedSeats, "requestedSeats", 1, 1_000);
  assertIntegerInRange(input.confirmedSeats, "confirmedSeats", 0, 1_000_000);
  assertIntegerInRange(input.heldSeats, "heldSeats", 0, 1_000_000);
  if (input.sharedInventory !== undefined) {
    assertIntegerInRange(input.sharedInventory.activeGroupCount, "sharedInventory.activeGroupCount", 0, 1_000_000);
  }
  assertUtcInstant(input.nowUtc, "nowUtc");
  assertUtcInstant(input.occurrence.startUtc, "occurrence.startUtc");
  assertUtcInstant(input.occurrence.endUtc, "occurrence.endUtc");
  if (input.occurrence.startUtc >= input.occurrence.endUtc) {
    throw new DomainValidationError(["occurrence must have startUtc before endUtc"]);
  }
  if (input.occurrence.timeZone !== EXPERIENCE_TIME_ZONE) {
    throw new DomainValidationError([`occurrence.timeZone must be ${EXPERIENCE_TIME_ZONE}`]);
  }
  assertIntegerInRange(input.occurrence.capacity, "occurrence.capacity", 1, 1_000);
  assertIntegerInRange(input.occurrence.bookingCutoffMinutes, "occurrence.bookingCutoffMinutes", 0, 525_600);
  assertIntegerInRange(input.occurrence.busyBufferBeforeMinutes, "occurrence.busyBufferBeforeMinutes", 0, 1_440);
  assertIntegerInRange(input.occurrence.busyBufferAfterMinutes, "occurrence.busyBufferAfterMinutes", 0, 1_440);
  const busyIntervals = parseBusyIntervals(input.googleCalendar.busyIntervals);
  const remainingCapacity = Math.max(0, input.occurrence.capacity - input.confirmedSeats - input.heldSeats);

  if (input.occurrence.status === "CLOSED") return result(input, "MANUALLY_CLOSED", remainingCapacity);

  const cutoffUtc = addMinutes(input.occurrence.startUtc, -input.occurrence.bookingCutoffMinutes);
  if (input.nowUtc >= cutoffUtc) return result(input, "BOOKING_CUTOFF_REACHED", remainingCapacity);

  if (input.sharedInventory?.bookingMode === "PRIVATE_GROUP" && input.sharedInventory.activeGroupCount > 0) {
    return result(input, "GROUP_RESERVED", remainingCapacity);
  }

  if (input.requestedSeats > remainingCapacity) return result(input, "INSUFFICIENT_CAPACITY", remainingCapacity);

  if (input.sharedInventory?.hasInactiveResource === true) return result(input, "RESOURCE_INACTIVE", remainingCapacity);
  if (input.sharedInventory?.hasResourceConflict === true) return result(input, "RESOURCE_BUSY", remainingCapacity);

  if (input.googleCalendar.blockingEnabled) {
    if (input.googleCalendar.syncStatus !== "FRESH") {
      return result(input, "GOOGLE_SYNC_UNAVAILABLE", remainingCapacity);
    }
    const bufferedOccurrence: BusyInterval = {
      startUtc: addMinutes(input.occurrence.startUtc, -input.occurrence.busyBufferBeforeMinutes),
      endUtc: addMinutes(input.occurrence.endUtc, input.occurrence.busyBufferAfterMinutes),
    };
    if (busyIntervals.some((busy) => intervalsOverlap(bufferedOccurrence, busy))) {
      return result(input, "GOOGLE_BUSY", remainingCapacity);
    }
  }

  return result(input, "AVAILABLE", remainingCapacity);
}
