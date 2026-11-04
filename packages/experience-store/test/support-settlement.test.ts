import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { calculateSettlementNetAmounts } from "../src/support-settlement.ts";

describe("Experience settlement net amounts", () => {
  it("subtracts the actual account-paid processing fee and adds the exact NIHO reimbursement", () => {
    assert.deepEqual(calculateSettlementNetAmounts({
      grossAmount: 10_000,
      successfulRefundAmount: 2_500,
      applicationFeeAmount: 1_500,
      applicationFeeRefunded: 375,
      processingFeeAmount: 360,
      feePayer: "ACCOUNT",
      compensationAmount: 360,
    }), { hostNet: 6_375, nihoNet: 765 });
  });

  it("does not subtract an application-paid processing cost from the host", () => {
    assert.deepEqual(calculateSettlementNetAmounts({
      grossAmount: 10_000,
      successfulRefundAmount: 10_000,
      applicationFeeAmount: 1_500,
      applicationFeeRefunded: 1_500,
      processingFeeAmount: 360,
      feePayer: "APPLICATION",
      compensationAmount: 0,
    }), { hostNet: 0, nihoNet: -360 });
  });

  it("keeps either final net unknown when an observed amount or fee payer is missing", () => {
    assert.deepEqual(calculateSettlementNetAmounts({
      grossAmount: 10_000,
      successfulRefundAmount: null,
      applicationFeeAmount: 1_500,
      applicationFeeRefunded: 0,
      processingFeeAmount: 360,
      feePayer: "ACCOUNT",
      compensationAmount: 360,
    }), { hostNet: null, nihoNet: null });
    assert.deepEqual(calculateSettlementNetAmounts({
      grossAmount: 10_000,
      successfulRefundAmount: 0,
      applicationFeeAmount: 1_500,
      applicationFeeRefunded: 0,
      processingFeeAmount: 360,
      feePayer: null,
      compensationAmount: null,
    }), { hostNet: null, nihoNet: null });
  });
});
