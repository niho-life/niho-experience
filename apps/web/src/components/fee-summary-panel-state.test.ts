import { describe, expect, it } from "vitest";
import type { ExperienceFeeSummary } from "@niho-experience/api-client/fee-summary";
import {
  feeSummaryPanelInstanceKey,
  feeSummaryTarget,
  feeSummaryViewFromResult,
  initialFeeSummaryView,
  loadFeeSummaryRequest,
  type FeeSummaryView,
} from "./fee-summary-panel-state";

const summary = (bookingRequestId: string, grossYen: number): ExperienceFeeSummary => ({
  version: "1.0.0",
  bookingRequestId,
  status: "SETTLED",
  feePolicy: {
    supportEnabled: true,
    totalRateBps: 1500,
    originalGrossYen: grossYen,
    originalApplicationFeeYen: Math.floor(grossYen * 0.15),
    processingFeesIncluded: true,
    laborPaidDirectlyByHost: true,
  },
  accounting: {
    successfulRefundedYen: 0,
    pendingRefundedYen: 0,
    targetTotalFeeYen: Math.floor(grossYen * 0.15),
    applicationFeeRefundedYen: 0,
    targetApplicationFeeRefundYen: 0,
    processingCompensatedYen: 0,
    targetProcessingCompensationYen: 0,
    hostRetainedAfterCreditsYen: grossYen - Math.floor(grossYen * 0.15),
    netNihoCashYen: Math.floor(grossYen * 0.15),
  },
  needsAttention: false,
  reason: null,
  evidenceCheckedAt: "2026-10-23T01:00:00.000Z",
  settledAt: "2026-10-23T02:00:00.000Z",
});

describe("fee summary panel request ownership", () => {
  it("ignores a slow JSON rejection after a newer target becomes current", async () => {
    let rejectOldJson: ((reason?: unknown) => void) | undefined;
    let oldJsonStarted: (() => void) | undefined;
    const jsonStarted = new Promise<void>((resolve) => { oldJsonStarted = resolve; });
    const oldJson = new Promise<unknown>((_resolve, reject) => { rejectOldJson = reject; });
    let oldIsCurrent = true;
    const oldRequest = loadFeeSummaryRequest({
      bookingId: "booking-old",
      request: async () => ({ status: 200, ok: true, json: () => { oldJsonStarted?.(); return oldJson; } }) as Response,
      isCurrent: () => oldIsCurrent,
    });

    await jsonStarted;
    oldIsCurrent = false;
    const newTarget = feeSummaryTarget("admin", "admin-1", "booking-new");
    let view: FeeSummaryView = feeSummaryViewFromResult(newTarget, { value: "ready", summary: summary("booking-new", 24_000) });
    rejectOldJson?.(new Error("late JSON failure"));
    const staleResult = await oldRequest;
    if (staleResult) view = feeSummaryViewFromResult(feeSummaryTarget("admin", "admin-1", "booking-old"), staleResult);

    expect(staleResult).toBeNull();
    expect(view).toMatchObject({ target: newTarget, value: "ready", summary: { bookingRequestId: "booking-new", feePolicy: { originalGrossYen: 24_000 } } });
  });
});

describe("fee summary panel target lifecycle", () => {
  it("destroys displayed data when disabled and waits for a fresh request after resuming", () => {
    const target = feeSummaryTarget("host", "provider-1", "booking-1");
    const enabledKey = feeSummaryPanelInstanceKey("host", "provider-1", "booking-1", true);
    const ready = feeSummaryViewFromResult(target, { value: "ready", summary: summary("booking-1", 12_000) });
    expect(ready.summary).not.toBeNull();

    const disabledKey = feeSummaryPanelInstanceKey("host", "provider-1", "booking-1", false);
    const disabled = initialFeeSummaryView(target, false);
    expect(disabledKey).not.toBe(enabledKey);
    expect(disabled).toEqual({ target, value: "disabled", summary: null });

    const resumedKey = feeSummaryPanelInstanceKey("host", "provider-1", "booking-1", true);
    const resumed = initialFeeSummaryView(target, true);
    expect(resumedKey).not.toBe(disabledKey);
    expect(resumed).toEqual({ target, value: "loading", summary: null });
  });

  it("uses audience and actor as part of the target and remount key", () => {
    const adminTarget = feeSummaryTarget("admin", "admin-1", "booking-1");
    const hostTarget = feeSummaryTarget("host", "provider-1", "booking-1");
    const otherActorTarget = feeSummaryTarget("host", "provider-2", "booking-1");
    expect(new Set([adminTarget, hostTarget, otherActorTarget])).toHaveLength(3);
    expect(feeSummaryPanelInstanceKey("admin", "admin-1", "booking-1", true)).not.toBe(feeSummaryPanelInstanceKey("host", "provider-1", "booking-1", true));
    expect(feeSummaryPanelInstanceKey("host", "provider-1", "booking-1", true)).not.toBe(feeSummaryPanelInstanceKey("host", "provider-2", "booking-1", true));
    expect(initialFeeSummaryView(hostTarget, true)).toEqual({ target: hostTarget, value: "loading", summary: null });
  });
});
