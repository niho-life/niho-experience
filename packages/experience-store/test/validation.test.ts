import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { expandOccurrences, type ScheduleRule } from "@niho-experience/experience-domain";
import { StoreValidationError } from "../src/errors.ts";
import { buildSnapshots, effectiveGoogleSyncStatus, normalizeCurrency, validateBusySync } from "../src/validation.ts";

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
});
