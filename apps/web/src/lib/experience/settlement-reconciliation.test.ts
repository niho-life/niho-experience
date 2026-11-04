import { beforeEach, describe, expect, it, vi } from "vitest";

const stripe = vi.hoisted(() => ({ read: vi.fn(), submit: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@niho-experience/experience-payments", () => ({ readBookingSettlement: stripe.read, submitSettlementTransfer: stripe.submit }));

import { runSettlementReconciliation, type SettlementReconciliationDeps } from "./settlement-reconciliation";

const bookingId = "0f8fad5b-d9cb-469f-a165-708677289501";
const command = {
  commandId: "00000000-0000-4000-8000-000000000221", publicBookingId: bookingId, amount: 360, currency: "JPY",
  destinationAccountId: "acct_1234567890", transferGroup: `niho-experience-settlement:${bookingId}`,
  status: "SUBMITTING" as const, stripeTransferRef: null, attempts: 1, createdAtUtc: "2026-11-01T00:00:00.000Z",
};

function dependencies(markCompensation: SettlementReconciliationDeps["repository"]["markCompensation"]): SettlementReconciliationDeps {
  return {
    platformStripeKey: "test-key",
    repository: {
      initializeMissingSettlements: vi.fn(async () => ({ initialized: 0, failed: 0 })),
      claimDueSettlements: vi.fn(async () => [bookingId]),
      getSettlementSource: vi.fn(async () => ({ publicBookingId: bookingId, connectedAccountId: "acct_1234567890", paymentIntentId: "pi_1234567890", grossAmount: 4000, currency: "JPY" })),
      recordStripeEvidence: vi.fn(async () => ({ issueCode: null }) as never),
      prepareCompensation: vi.fn(async () => command),
      markCompensation,
    },
  };
}

beforeEach(() => vi.clearAllMocks());

describe("settlement reconciliation recovery", () => {
  it("reuses a durable command after Stripe succeeded but its database result write failed", async () => {
    stripe.read.mockResolvedValue({});
    stripe.submit
      .mockResolvedValueOnce({ kind: "transferred", stripeTransferRef: "tr_1234567890" })
      .mockResolvedValueOnce({ kind: "already_transferred", stripeTransferRef: "tr_1234567890" });
    let firstRun = true;
    const mark = vi.fn(async (_id: string, update: Parameters<SettlementReconciliationDeps["repository"]["markCompensation"]>[1]) => {
      if (firstRun && (update.status === "TRANSFERRED" || update.status === "RESULT_UNKNOWN")) throw new Error("database unavailable");
    });
    const deps = dependencies(mark as unknown as SettlementReconciliationDeps["repository"]["markCompensation"]);

    await expect(runSettlementReconciliation(deps)).rejects.toThrow("Settlement reconciliation failed.");
    firstRun = false;
    const recovered = await runSettlementReconciliation(deps);

    expect(recovered.transferred).toBe(1);
    expect(stripe.submit).toHaveBeenCalledTimes(2);
    expect(stripe.submit).toHaveBeenNthCalledWith(1, expect.objectContaining({ command }));
    expect(stripe.submit).toHaveBeenNthCalledWith(2, expect.objectContaining({ command }));
    expect(mark.mock.calls.map((call) => call[1].status)).toEqual(["SUBMITTING", "TRANSFERRED", "RESULT_UNKNOWN", "SUBMITTING", "TRANSFERRED"]);
  });
});
