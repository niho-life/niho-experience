import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Pool } from "pg";
import { ChannelRuntime, channelReadbackAccepted, type ChannelTarget, type ExternalReservationObservation } from "../src/channels.ts";
import { StoreValidationError } from "../src/errors.ts";

const target: ChannelTarget = {
  site: "Airbnb",
  externalAccountId: "external-account",
  externalProductId: "external-product",
  externalOptionId: "morning",
  timeZone: "Asia/Tokyo",
  adapter: "browser-v1",
  adapterVersion: "1",
  connectionMode: "BROWSER",
};

describe("channel result state machine", () => {
  it("accepts only a stopped, current, exact, structured VERIFIED readback", () => {
    const base = {
      action: "SET_OPEN" as const, expectedTarget: target, resultTarget: target, outcome: "VERIFIED" as const,
      stopped: true, withinLease: true, versionsCurrent: true, observedState: "OPEN" as const,
      occurrenceMatches: true, observationTimeValid: true, observedBookable: true, observedManuallyBlocked: false,
      observedAtUtc: "2099-01-01T00:00:00.000Z",
    };
    assert.equal(channelReadbackAccepted(base), true);
    assert.equal(channelReadbackAccepted({ ...base, stopped: false }), false);
    assert.equal(channelReadbackAccepted({ ...base, withinLease: false }), false);
    assert.equal(channelReadbackAccepted({ ...base, versionsCurrent: false }), false);
    assert.equal(channelReadbackAccepted({ ...base, occurrenceMatches: false }), false);
    assert.equal(channelReadbackAccepted({ ...base, observationTimeValid: false }), false);
    assert.equal(channelReadbackAccepted({ ...base, outcome: "UNKNOWN_AFTER_SAVE" }), false);
    assert.equal(channelReadbackAccepted({ ...base, observedState: "CLOSED" }), false);
    assert.equal(channelReadbackAccepted({ ...base, observedBookable: false }), false);
    assert.equal(channelReadbackAccepted({ ...base, resultTarget: { ...target, externalOptionId: "afternoon" } }), false);
    const googleTarget = { ...target, adapter: "airbnb-google-busy", connectionMode: "GOOGLE" as const };
    assert.equal(channelReadbackAccepted({ ...base, expectedTarget: googleTarget, resultTarget: googleTarget }), false);
  });

  it("requires a manual block for close and keeps an unblocked-but-not-bookable OBSERVE distinct", () => {
    const base = {
      expectedTarget: target, resultTarget: target, outcome: "VERIFIED" as const, stopped: true,
      withinLease: true, versionsCurrent: true, occurrenceMatches: true, observationTimeValid: true,
      observedAtUtc: "2099-01-01T00:00:00.000Z",
    };
    assert.equal(channelReadbackAccepted({ ...base, action: "SET_CLOSED", observedState: "CLOSED", observedBookable: false, observedManuallyBlocked: true }), true);
    assert.equal(channelReadbackAccepted({ ...base, action: "SET_CLOSED", observedState: "CLOSED", observedBookable: false, observedManuallyBlocked: false }), false);
    assert.equal(channelReadbackAccepted({ ...base, action: "SET_CLOSED", observedState: "OPEN", observedBookable: false, observedManuallyBlocked: true }), false);
    assert.equal(channelReadbackAccepted({ ...base, action: "OBSERVE", observedState: "OPEN", observedBookable: false, observedManuallyBlocked: false }), true);
  });
});

describe("external reservation input validation", () => {
  const runtime = new ChannelRuntime({} as Pool);
  const worker = { workerId: "synthetic-worker", credentialVersion: 1 };
  const observation: ExternalReservationObservation = {
    externalReservationId: "external-1", externalProductId: "product", sourceStartAtUtc: "2099-01-01T01:00:00.000Z",
    sourceEndAtUtc: "2099-01-01T02:00:00.000Z", status: "CONFIRMED", seats: 1,
  };
  const base = {
    receiptId: "00000000-0000-4000-8000-000000000001",
    readId: "00000000-0000-4000-8000-000000000002",
    leaseToken: "synthetic-lease",
    batchStatus: "COMPLETE" as const,
    observations: [observation],
  };

  it("rejects duplicate IDs, non-canonical UTC, and facts in a failed batch before a database call", async () => {
    await assert.rejects(() => runtime.submitReservationRead(worker, "00000000-0000-4000-8000-000000000003", {
      ...base, observations: [observation, { ...observation }],
    }), StoreValidationError);
    await assert.rejects(() => runtime.submitReservationRead(worker, "00000000-0000-4000-8000-000000000003", {
      ...base, observations: [{ ...observation, sourceStartAtUtc: "2099-01-01 01:00:00" }],
    }), StoreValidationError);
    await assert.rejects(() => runtime.submitReservationRead(worker, "00000000-0000-4000-8000-000000000003", {
      ...base, batchStatus: "FAILED", observations: base.observations,
    }), StoreValidationError);
  });

  it("rejects invalid window page order, bounds, and terminal evidence before a database call", async () => {
    const windowBase = {
      receiptId: base.receiptId, readId: base.readId, leaseToken: base.leaseToken, pageNumber: 0,
      nextSourceCursor: "next", observations: [observation],
    };
    await assert.rejects(() => runtime.submitReservationWindowPage(worker, "00000000-0000-4000-8000-000000000003", {
      ...windowBase, observations: Array.from({ length: 33 }, (_, index) => ({ ...observation, externalReservationId: `external-${index}` })),
    }), StoreValidationError);
    await assert.rejects(() => runtime.submitReservationWindowPage(worker, "00000000-0000-4000-8000-000000000003", {
      receiptId: windowBase.receiptId, readId: windowBase.readId, leaseToken: windowBase.leaseToken,
      pageNumber: windowBase.pageNumber, observations: windowBase.observations,
    }), StoreValidationError);
    await assert.rejects(() => runtime.submitReservationWindowPage(worker, "00000000-0000-4000-8000-000000000003", {
      ...windowBase, terminal: { status: "FAILED", completedAtUtc: "2099-01-01T02:00:00.000Z",
        allPagesRead: false, allStatusesIncluded: false, coverageComplete: false },
    }), StoreValidationError);
    await assert.rejects(() => runtime.submitReservationWindowPage(worker, "00000000-0000-4000-8000-000000000003", {
      ...windowBase, pageNumber: 1, previousReceiptId: "00000000-0000-4000-8000-000000000004",
    }), StoreValidationError);
  });
});
