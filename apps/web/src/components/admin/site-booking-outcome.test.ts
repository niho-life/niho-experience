import { describe, expect, it } from "vitest";
import { siteBookingCommandRejected, siteBookingOutcome, siteBookingPreview } from "./site-booking-outcome";

const cancelled = (states: string[]) => ({
  outcome: "CANCELLED", repeated: false, bookingIds: ["synthetic-booking"],
  refunds: states.map((status, index) => ({ refundId: `synthetic-refund-${index}`, status })),
});

describe("support operation results", () => {
  it("retains an uncertain command through route closure, rate limiting and malformed refusals", () => {
    for (const [status, body] of [[404, { error: "not_found" }], [429, {}], [503, {}], [409, {}], [400, null]] as const) {
      expect(siteBookingCommandRejected(status, body)).toBe(false);
    }
    expect(siteBookingCommandRejected(400, { error: "invalid_input" })).toBe(true);
    expect(siteBookingCommandRejected(409, { error: "conflict" })).toBe(true);
  });
  it("does not confirm malformed or incomplete success responses", () => {
    for (const value of [null, {}, [], { outcome: "CANCELLED" }, { ...cancelled([]), outcome: "UNKNOWN" }, cancelled(["UNKNOWN"])]) {
      expect(siteBookingOutcome(value)).toBeNull();
    }
  });

  it("distinguishes a committed cancellation from an unsent or unknown refund", () => {
    expect(siteBookingOutcome(cancelled(["REQUESTED"]))).toMatchObject({ tone: "error", text: expect.stringContaining("受付待ち") });
    expect(siteBookingOutcome(cancelled(["REQUESTED"]))?.text).not.toContain("送りました");
  });

  it("reports pending and failed refunds without calling them completed", () => {
    expect(siteBookingOutcome(cancelled(["PENDING"]))?.text).toContain("返金処理中");
    expect(siteBookingOutcome(cancelled(["PENDING"]))?.text).not.toContain("返金完了");
    expect(siteBookingOutcome(cancelled(["FAILED"]))).toMatchObject({ tone: "error", text: expect.stringContaining("返金に失敗") });
  });

  it("confirms completion only when every returned refund succeeded", () => {
    expect(siteBookingOutcome(cancelled(["SUCCEEDED", "SUCCEEDED"]))?.text).toContain("返金完了");
    expect(siteBookingOutcome(cancelled(["SUCCEEDED", "REQUESTED"]))?.text).not.toContain("返金完了");
    expect(siteBookingOutcome(cancelled([]))?.text).not.toContain("返金完了");
  });

  it("does not invent an automatic resend when a repeated command has no new refund", () => {
    const result = siteBookingOutcome({ ...cancelled([]), outcome: "REFUND_RETRIED", repeated: true });
    expect(result?.text).toContain("一覧で確認");
    expect(result?.text).not.toMatch(/自動|完了|送った|送りました/);
  });

  it("distinguishes registering a support message from delivering it", () => {
    expect(siteBookingOutcome({ outcome: "CONTACT_SENT", repeated: false })?.text).toContain("配信キューに登録");
  });

  it("accepts only a complete preview DTO before arming a financial command", () => {
    const preview = {
      action: "CANCEL", expectedSnapshot: "a".repeat(64), publicBookingId: "0f8fad5b-d9cb-469f-a165-708677289501", providerId: "provider-a",
      experienceTitle: "Synthetic walk", startUtc: "2026-11-10T01:00:00.000Z", bookingStatus: "CONFIRMED",
      bookingStatusAfter: "CANCELLED", refundAmount: 3000, currency: "JPY", cancellationRequestStatus: null,
    };
    expect(siteBookingPreview(preview)).toEqual(preview);
    for (const value of [{ ...preview, expectedSnapshot: "short" }, { ...preview, refundAmount: -1 }, { ...preview, action: "UNKNOWN" }, { ...preview, startUtc: "later" }]) {
      expect(siteBookingPreview(value)).toBeNull();
    }
  });
});
