import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { channelReadbackAccepted, type ChannelTarget } from "../src/channels.ts";

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
