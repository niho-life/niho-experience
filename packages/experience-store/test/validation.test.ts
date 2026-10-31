import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { expandOccurrences, type ScheduleRule } from "@niho-experience/experience-domain";
import { StoreValidationError } from "../src/errors.ts";
import { buildSnapshots, chargeablePlatformFee, effectiveGoogleSyncStatus, normalizeCurrency, platformFeeAmount, validateBusySync } from "../src/validation.ts";

const rule: ScheduleRule = {
  id: "tea-am",
  timeZone: "Asia/Tokyo",
  startsOn: "2099-01-01",
  localStartTime: "10:00",
  durationMinutes: 90,
  capacity: 4,
  bookingCutoffMinutes: 120,
  busyBufferBeforeMinutes: 15,
  busyBufferAfterMinutes: 15,
  recurrence: { kind: "DAILY" },
};

describe("store boundary validation", () => {
  it("treats an expired successful Google sync as stale and preserves failures", () => {
    assert.equal(effectiveGoogleSyncStatus("FRESH", "2026-10-27T01:00:00.000Z", "2026-10-27T01:00:00.000Z"), "STALE");
    assert.equal(effectiveGoogleSyncStatus("FRESH", "2026-10-27T01:00:00.001Z", "2026-10-27T01:00:00.000Z"), "FRESH");
    assert.equal(effectiveGoogleSyncStatus("FAILED", "2099-01-01T00:00:00.000Z", "2026-10-27T01:00:00.000Z"), "FAILED");
  });

  it("accepts only interval boundaries and requires a future freshness deadline", () => {
    assert.deepEqual(
      validateBusySync("2026-10-27T00:00:00.000Z", "2026-10-27T00:05:00.000Z", [
        {
          startUtc: "2026-10-28T00:00:00.000Z",
          endUtc: "2026-10-28T01:00:00.000Z",
          title: "must not cross the boundary",
        } as never,
      ]),
      [{ startUtc: "2026-10-28T00:00:00.000Z", endUtc: "2026-10-28T01:00:00.000Z" }],
    );
    assert.throws(
      () => validateBusySync("2026-10-27T00:00:00.000Z", "2026-10-27T00:00:00.000Z", []),
      StoreValidationError,
    );
  });

  it("builds immutable-value booking snapshots from the domain occurrence and current product", () => {
    const occurrence = expandOccurrences({ rule, fromDate: "2099-01-01", toDate: "2099-01-01" })[0]!;
    const snapshots = buildSnapshots(occurrence, 2, "2098-12-01T00:00:00.000Z", {
      providerId: "provider-a",
      currency: "jpy",
      unitAmount: 4500,
      cancellationTermsRef: "terms-v1",
      sellerNihoAccountRef: "niho-seller-a",
      stripeConnectAccountRef: "acct_synthetic",
      sellerDisplayName: "Synthetic Seller",
    });
    assert.deepEqual(snapshots.pricingSnapshot, {
      currency: "JPY",
      unitAmount: 4500,
      seats: 2,
      totalAmount: 9000,
      cancellationTermsRef: "terms-v1",
    });
    assert.equal(snapshots.occurrenceSnapshot.startUtc, occurrence.startUtc);
    assert.equal(snapshots.sellerSnapshot.experienceProviderId, "provider-a");
    assert.equal(normalizeCurrency("usd"), "USD");
  });

  it("rounds NIHO's fee down to the yen and keeps it a fee Stripe accepts (#285)", () => {
    assert.equal(platformFeeAmount(3333, 1000), 333);
    assert.equal(platformFeeAmount(3333, 1500), 499);
    assert.equal(platformFeeAmount(50, 1500), 7);
    assert.equal(chargeablePlatformFee(50, 1000), true);
    // Below ¥10 at 10 % (¥7 at 15 %) the fee would be ¥0: Stripe takes no such application fee.
    assert.equal(chargeablePlatformFee(9, 1000), false);
    assert.equal(chargeablePlatformFee(7, 1500), true);
    assert.equal(chargeablePlatformFee(6, 1500), false);

    const occurrence = expandOccurrences({ rule, fromDate: "2099-01-01", toDate: "2099-01-01" })[0]!;
    const product = {
      providerId: "provider-a", currency: "JPY", unitAmount: 3333, cancellationTermsRef: "terms-v1",
      sellerNihoAccountRef: "niho-seller-a", stripeConnectAccountRef: "acct_synthetic", sellerDisplayName: "Synthetic Seller",
    };
    const guest = (supportEnabled: boolean, basisPoints: 1000 | 1500) => ({
      breakdown: { adultCount: 1, childCount: 1, childUnitAmount: 0 }, cancellationPolicy: "NONE" as const, platformFee: { supportEnabled, basisPoints },
    });
    assert.deepEqual(buildSnapshots(occurrence, 2, "2098-12-01T00:00:00.000Z", product, guest(true, 1500)).pricingSnapshot.platformFee, {
      supportEnabled: true, basisPoints: 1500, amount: 499,
    });
    assert.throws(() => buildSnapshots(occurrence, 2, "2098-12-01T00:00:00.000Z", product, guest(true, 1000)), StoreValidationError);
    assert.throws(() => buildSnapshots(occurrence, 2, "2098-12-01T00:00:00.000Z", { ...product, unitAmount: 6 }, guest(true, 1500)), StoreValidationError);
  });
});
