import { describe, expect, it } from "vitest";
import { normalizeAdminOperationBody, normalizeAdminOperationSubject, sameAdminOperationConfirmationSnapshot } from "./AdminBookingOperations";

const booking = {
  bookingRequestId: "booking.1", revision: 1, updatedAt: "2026-10-23T01:00:00.000Z",
  host: { kind: "SPOT" as const, id: "spot.1", displayName: "合成ホスト" }, guest: { displayName: "合成予約者" }, status: "PROVISIONAL",
  totalYen: 12000, refundedYen: 0, providerRefund: { status: "KNOWN" as const, refundedYen: 0, observedAt: "2026-10-23T01:00:00.000Z" },
  refundOptions: [{ choice: "FULL" as const, refundAmountYen: 12000, resultRefundedYen: 12000 }], occurrenceDate: "2026-11-03",
  startAt: "2026-11-03T01:00:00.000Z", endAt: "2026-11-03T03:00:00.000Z", approvalDeadlineAt: "2026-10-24T01:00:00.000Z",
  actions: { approve: { allowed: true, reason: null }, decline: { allowed: true, reason: null }, cancel: { allowed: false, reason: "STATUS" }, message: { allowed: true, reason: null } },
};

describe("admin operation confirmation contract", () => {
  it("normalizes exactly what is shown and sent", () => {
    expect(normalizeAdminOperationSubject("  日程\n  確認  ")).toBe("日程 確認");
    expect(normalizeAdminOperationBody("\r\n 1行目\r\n2行目 \r\n")).toBe("1行目\n2行目");
  });
  it("a fresh provider observation time alone does not change the confirmed money", () => {
    expect(sameAdminOperationConfirmationSnapshot(booking, { ...booking, providerRefund: {
      ...booking.providerRefund, observedAt: "2026-10-23T01:00:03.000Z",
    } })).toBe(true);
    expect(sameAdminOperationConfirmationSnapshot(booking, { ...booking, providerRefund: {
      ...booking.providerRefund, refundedYen: 1000,
    } })).toBe(false);
  });
  it("requires reconfirmation for actions-only, deadline and refund option changes", () => {
    expect(sameAdminOperationConfirmationSnapshot(booking, { ...booking })).toBe(true);
    expect(sameAdminOperationConfirmationSnapshot(booking, { ...booking, actions: { ...booking.actions, approve: { allowed: false, reason: "STATUS" } } })).toBe(false);
    expect(sameAdminOperationConfirmationSnapshot(booking, { ...booking, approvalDeadlineAt: "2026-10-25T01:00:00.000Z" })).toBe(false);
    expect(sameAdminOperationConfirmationSnapshot(booking, { ...booking, refundOptions: [{ choice: "FULL", refundAmountYen: 11000, resultRefundedYen: 11000 }] })).toBe(false);
  });
});
