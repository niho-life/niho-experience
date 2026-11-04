import { describe, expect, it } from "vitest";
import { siteBookingOutcome } from "./site-booking-outcome";

const cancelled = (states: string[]) => ({
  outcome: "CANCELLED", repeated: false, bookingIds: ["synthetic-booking"],
  refunds: states.map((status, index) => ({ refundId: `synthetic-refund-${index}`, status })),
});

describe("support operation results", () => {
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
});
