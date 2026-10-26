import { describe, expect, it } from "vitest";
import { canDecideLiveBooking, findUncertainMessage } from "./live-booking-state";

const message = (id: string, subject: string) => ({ id, subject, createdAt: "2026-10-27T00:00:00.000Z", sentAt: null, failed: false, deliveryStatus: "QUEUED" as const });

describe("live booking state", () => {
  it("allows decisions only for the canonical provisional state", () => {
    expect(canDecideLiveBooking("PROVISIONAL")).toBe(true);
    expect(canDecideLiveBooking("PENDING")).toBe(false);
    expect(canDecideLiveBooking("UNKNOWN")).toBe(false);
  });

  it("matches an accepted reply by its returned receipt without mistaking old history", () => {
    const history = [message("old", "同じ件名"), message("receipt-1", "同じ件名")];
    expect(findUncertainMessage(history, ["old"], "receipt-1", "同じ件名")?.id).toBe("receipt-1");
    expect(findUncertainMessage(history, ["old"], "missing", "同じ件名")).toBeNull();
  });

  it("uses a newly added matching subject only when no receipt was returned", () => {
    const history = [message("old", "案内"), message("new", "案内")];
    expect(findUncertainMessage(history, ["old"], null, "案内")?.id).toBe("new");
    expect(findUncertainMessage([history[0]!], ["old"], null, "案内")).toBeNull();
  });
});
