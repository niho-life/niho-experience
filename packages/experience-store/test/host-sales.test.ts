import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StoreValidationError } from "../src/errors.ts";
import { refundedFeeShare, refundFeeMovement, salesWindowOf } from "../src/host-sales.ts";

/** 売上 (#91): NIHO's fee a refund gives back, and the window a read takes. No database. */
describe("NIHO's fee given back with a refund", () => {
  it("gives back the whole fee with a full refund, and nothing with none", () => {
    assert.deepEqual(refundFeeMovement(750, 7500, 0, 7500), { amount: -750, estimated: false });
    assert.deepEqual(refundFeeMovement(750, 7500, 0, 0), { amount: 0, estimated: false });
    // Its reversal takes the fee again.
    assert.deepEqual(refundFeeMovement(750, 7500, 7500, -7500), { amount: 750, estimated: false });
  });

  it("gives back a partial refund's share, half up, and the rest with the last refund", () => {
    // 750 × 3333 ÷ 7500 = 333.3 → 333; 750 × 3750 ÷ 7500 = 375 exactly.
    assert.deepEqual(refundFeeMovement(750, 7500, 0, 3333), { amount: -333, estimated: true });
    assert.deepEqual(refundFeeMovement(750, 7500, 0, 3750), { amount: -375, estimated: true });
    // 1125 × 1 ÷ 2250 = 0.5 → 1 (half up).
    assert.equal(refundedFeeShare(1125, 1, 2250), 1);
    // However the refunds split it, a booking refunded in full has given back its whole fee.
    const parts = [1, 2999, 333, 4167].reduce<{ before: number; total: number }>(({ before, total }, part) => ({ before: before + part, total: total + refundFeeMovement(750, 7500, before, part).amount }), { before: 0, total: 0 });
    assert.deepEqual(parts, { before: 7500, total: -750 });
    assert.equal(refundFeeMovement(750, 7500, 3333, 4167).estimated, true);
  });

  it("never gives back more than the fee when the refunds pass what was paid", () => {
    assert.deepEqual(refundFeeMovement(750, 7500, 7000, 1000), { amount: -50, estimated: true });
    assert.deepEqual(refundFeeMovement(750, 7500, 9000, 1000), { amount: 0, estimated: false });
  });

  it("keeps every digit of large amounts", () => {
    assert.equal(refundedFeeShare(1_499_999_999, 9_999_999_998, 9_999_999_999), 1_499_999_999);
    assert.equal(refundedFeeShare(999_999_999, 4_999_999_999, 9_999_999_999), 499_999_999);
  });
});

describe("the window a read takes", () => {
  it("is a pair of canonical instants, `to` after `from`, at most 92 days", () => {
    assert.deepEqual(salesWindowOf({ from: "2026-10-31T15:00:00.000Z", to: "2026-11-30T15:00:00.000Z" }), { from: "2026-10-31T15:00:00.000Z", to: "2026-11-30T15:00:00.000Z" });
    assert.throws(() => salesWindowOf({ from: "2026-11-01", to: "2026-11-30T15:00:00.000Z" }), StoreValidationError);
    assert.throws(() => salesWindowOf({ from: "2026-11-30T15:00:00.000Z", to: "2026-11-30T15:00:00.000Z" }), StoreValidationError);
    assert.throws(() => salesWindowOf({ from: "2026-01-01T00:00:00.000Z", to: "2026-04-03T00:00:00.001Z" }), StoreValidationError);
    assert.throws(() => salesWindowOf(null), StoreValidationError);
  });
});
