import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { AGENT_PAYOUT_LIMITS } from "@niho-experience/experience-store";
import { AGENT_PAYOUT_ROW_WORST_CASE_MS, AGENT_PAYOUT_STRIPE_RETRIES, AGENT_PAYOUT_STRIPE_TIMEOUT_MS } from "@niho-experience/experience-payments";
import { runAgentPayouts, type AgentPayoutsDeps } from "./agent-payouts";

const ACCOUNT = "acct_HostPayout0001";
const command = {
  commandId: "00000000-0000-4000-8000-000000000221", payoutId: "00000000-0000-4000-8000-000000000222", publicBookingId: "0f8fad5b-d9cb-469f-a165-708677289501",
  amount: 8_500, currency: "JPY" as const, destinationAccountId: ACCOUNT, chargeRef: "ch_AgentCharge0001",
  transferGroup: "niho-experience-agent-payout:0f8fad5b-d9cb-469f-a165-708677289501", createdAtUtc: "2026-12-01T00:00:00.000Z",
};
const destination = { kind: "destination" as const, payoutId: command.payoutId, providerId: "provider-a", publicBookingId: command.publicBookingId, paymentRef: "pi_AgentIntent0001", capturedAmount: 10_000, refundedAmount: 2_000, disputeCount: 1 };
const ready = { kind: "read" as const, state: "READY" as const, payoutReady: true, detailsSubmitted: true, payoutsEnabled: true, transfersActive: true, requirementsHash: "a".repeat(64), mismatch: false };

function setup(over: { lostLease?: boolean; paused?: boolean; budgetMs?: number; ids?: string[]; clock?: () => Date; prepared?: unknown; current?: unknown; status?: unknown; charge?: unknown; submit?: () => Promise<unknown>; reversals?: unknown[] } = {}) {
  const repository = {
    initializeMissing: vi.fn(async () => ({ initialized: 1, failed: 0 })),
    claimDueLeased: vi.fn(async () => (over.ids ?? [command.payoutId]).map((id) => ({ id, token: `token-${id}` }))),
    extendLease: vi.fn(async (_id: string, token: string) => (over.lostLease ? null : `${token}+`)),
    extendReversalLease: vi.fn(async () => (over.lostLease ? null : "extended")),
    prepare: vi.fn(async () => over.prepared ?? destination),
    awaitAccount: vi.fn(async () => ({ status: "AWAITING_ACCOUNT", mailQueued: true })),
    markReview: vi.fn(async () => {}),
    begin: vi.fn(async () => command),
    recordTransfer: vi.fn(async () => "TRANSFERRED"),
    claimDueReversals: vi.fn(async () => over.reversals ?? []),
    recordReversal: vi.fn(async () => "REVERSED"),
    escalateStaleOffsets: vi.fn(async () => 0),
  };
  const connectAccounts = {
    currentPayout: vi.fn(async () => over.current === undefined ? { account: { id: "11111111-1111-4111-8111-111111111111", stripeAccountRef: ACCOUNT }, snapshot: null } : over.current),
    saveSnapshot: vi.fn(async () => ({ saved: true, mailQueued: false })),
  };
  const payments = {
    retrieveAccountStatus: vi.fn(async () => over.status ?? ready),
    retrieveCharge: vi.fn(async () => over.charge ?? { kind: "ok", chargeRef: "ch_AgentCharge0001", amount: 10_000, currency: "JPY" }),
    submitTransfer: vi.fn(over.submit ?? (async () => ({ kind: "transferred", stripeTransferRef: "tr_AgentTransfer0001" }))),
    reverseTransfer: vi.fn(async () => ({ kind: "reversed", stripeReversalRef: "trr_AgentReversal0001" })),
  };
  const deps = { repository, connectAccounts, platformStripeKey: "sk_test_synthetic", payments, paused: over.paused, budgetMs: over.budgetMs, now: over.clock ?? (() => new Date("2026-12-10T00:00:00.000Z")) } as unknown as AgentPayoutsDeps;
  return { deps, repository, connectAccounts, payments };
}

beforeEach(() => vi.clearAllMocks());

describe("runAgentPayouts", () => {
  it("sends the share: the account read, the Charge read, the command begun, then the transfer recorded", async () => {
    const s = setup();
    const counts = await runAgentPayouts(s.deps);
    expect(counts).toMatchObject({ initialized: 1, claimed: 1, transferred: 1, awaitingAccount: 0, failed: 0 });
    expect(s.connectAccounts.saveSnapshot).toHaveBeenCalledOnce();
    expect(s.payments.retrieveCharge).toHaveBeenCalledWith(expect.objectContaining({ paymentIntentId: "pi_AgentIntent0001", expectedAmount: 10_000, knownRefundedAmount: 2_000, knownDisputeCount: 1 }));
    expect(s.repository.begin).toHaveBeenCalledWith(command.payoutId, { destination: { connectAccountId: "11111111-1111-4111-8111-111111111111", accountRef: ACCOUNT }, charge: { ref: "ch_AgentCharge0001", amount: 10_000, currency: "JPY" } }, expect.any(Date));
    expect(s.payments.submitTransfer).toHaveBeenCalledWith(expect.objectContaining({ command }));
    expect(s.repository.recordTransfer).toHaveBeenCalledWith(command.payoutId, command.commandId, { kind: "transferred", stripeTransferRef: "tr_AgentTransfer0001" });
  });

  it("waits for an account that is missing, unreachable or not payout-ready, and sends nothing", async () => {
    for (const over of [{ current: null }, { status: { kind: "unreachable" } }, { status: { ...ready, payoutReady: false, state: "VERIFYING" } }]) {
      const s = setup(over);
      const counts = await runAgentPayouts(s.deps);
      expect(counts.awaitingAccount).toBe(1);
      expect(s.repository.awaitAccount).toHaveBeenCalledOnce();
      expect(s.repository.begin).not.toHaveBeenCalled();
      expect(s.payments.submitTransfer).not.toHaveBeenCalled();
    }
  });

  it("stops a payout whose Charge is not the payment", async () => {
    const s = setup({ charge: { kind: "mismatch", issueCode: "agent_payout_charge_amount_mismatch" } });
    const counts = await runAgentPayouts(s.deps);
    expect(s.repository.markReview).toHaveBeenCalledWith(command.payoutId, "agent_payout_charge_amount_mismatch");
    expect(counts.attention).toBe(1);
    expect(s.repository.begin).not.toHaveBeenCalled();
  });

  it("records an unknown result when the transfer call throws, and looks the transfer up first on the next run", async () => {
    const s = setup({ submit: async () => { throw new Error("network"); } });
    const counts = await runAgentPayouts(s.deps);
    expect(s.repository.recordTransfer).toHaveBeenCalledWith(command.payoutId, command.commandId, { kind: "unknown" });
    expect(counts).toMatchObject({ transferred: 0, attention: 1, failed: 0 });
    const next = setup({ prepared: { kind: "reconcile", command } });
    await runAgentPayouts(next.deps);
    expect(next.connectAccounts.currentPayout).not.toHaveBeenCalled();
    expect(next.payments.retrieveCharge).not.toHaveBeenCalled();
    expect(next.payments.submitTransfer).toHaveBeenCalledOnce();
    expect(next.repository.begin).not.toHaveBeenCalled();
  });

  it("one payout's failure does not stop the others, and the step reports it", async () => {
    const s = setup();
    s.repository.claimDueLeased.mockResolvedValue([command.payoutId, "00000000-0000-4000-8000-000000000333"].map((id) => ({ id, token: `token-${id}` })));
    s.repository.prepare.mockRejectedValueOnce(new Error("db")).mockResolvedValueOnce(destination as never);
    await expect(runAgentPayouts(s.deps)).rejects.toMatchObject({ counts: { claimed: 2, transferred: 1, failed: 1 } });
  });

  it("takes back what was sent too much: the reversal is asked, an exception is recorded as unknown", async () => {
    const reversal = { leaseToken: "reversal-token", adjustmentId: "00000000-0000-4000-8000-000000000444", payoutId: command.payoutId, publicBookingId: command.publicBookingId, stripeTransferRef: "tr_AgentTransfer0001", amount: 2_550 };
    const s = setup({ prepared: { kind: "idle" }, reversals: [reversal] });
    const counts = await runAgentPayouts(s.deps);
    expect(s.payments.reverseTransfer).toHaveBeenCalledWith(expect.objectContaining({ transferRef: "tr_AgentTransfer0001", adjustmentId: reversal.adjustmentId, amount: 2_550 }));
    expect(counts.reversed).toBe(1);
    const broken = setup({ prepared: { kind: "idle" }, reversals: [reversal] });
    broken.payments.reverseTransfer.mockRejectedValue(new Error("network"));
    await runAgentPayouts(broken.deps);
    expect(broken.repository.recordReversal).toHaveBeenCalledWith(reversal.adjustmentId, { kind: "unknown" });
  });

  it("paused: recalculates and looks an unknown transfer up, but creates no transfer or reversal and reads no account", async () => {
    const due = setup({ paused: true });
    const counts = await runAgentPayouts(due.deps);
    expect(counts).toMatchObject({ claimed: 1, transferred: 0, failed: 0 });
    expect(due.repository.prepare).toHaveBeenCalledOnce();
    for (const fn of [due.connectAccounts.currentPayout, due.payments.retrieveAccountStatus, due.payments.retrieveCharge, due.repository.begin, due.payments.submitTransfer, due.repository.claimDueReversals]) expect(fn).not.toHaveBeenCalled();
    // An unknown transfer is looked up without creating; found, it is recorded; not found, nothing is written.
    const unknown = setup({ paused: true, prepared: { kind: "reconcile", command }, submit: async () => ({ kind: "unknown" }) });
    await runAgentPayouts(unknown.deps);
    expect(unknown.payments.submitTransfer).toHaveBeenCalledWith(expect.objectContaining({ create: false }));
    expect(unknown.repository.recordTransfer).not.toHaveBeenCalled();
    const found = setup({ paused: true, prepared: { kind: "reconcile", command }, submit: async () => ({ kind: "already_transferred", stripeTransferRef: "tr_AgentTransfer0001" }) });
    await runAgentPayouts(found.deps);
    expect(found.repository.recordTransfer).toHaveBeenCalledWith(command.payoutId, command.commandId, { kind: "already_transferred", stripeTransferRef: "tr_AgentTransfer0001" });
    expect((await (async () => { const live = setup(); await runAgentPayouts(live.deps); return (live.payments.submitTransfer.mock.calls as unknown as unknown[][])[0]![0] as object; })())).not.toHaveProperty("create");
  });

  it("stops calling Stripe when its time budget is spent; the rest wait for the next run", async () => {
    let ms = 0;
    const clock = () => new Date(Date.UTC(2026, 11, 10) + ms);
    const s = setup({ budgetMs: 1_000, clock, ids: ["00000000-0000-4000-8000-000000000333", command.payoutId, "00000000-0000-4000-8000-000000000334"] });
    s.repository.prepare.mockImplementation(async () => { ms += 600; return { kind: "idle" } as never; });
    const counts = await runAgentPayouts(s.deps);
    expect(s.repository.prepare).toHaveBeenCalledTimes(2);
    expect(counts).toMatchObject({ claimed: 3, failed: 0 });
    expect(s.repository.claimDueReversals).not.toHaveBeenCalled();
  });

  it("extends the lease right before Stripe is called, with the claim's own token, and again before the transfer", async () => {
    const s = setup();
    await runAgentPayouts(s.deps);
    expect(s.repository.extendLease.mock.calls.map((call) => call.slice(0, 2))).toEqual([[command.payoutId, `token-${command.payoutId}`], [command.payoutId, `token-${command.payoutId}+`]]);
    const order = [s.repository.extendLease.mock.invocationCallOrder[0]!, s.payments.retrieveAccountStatus.mock.invocationCallOrder[0]!, s.repository.extendLease.mock.invocationCallOrder[1]!, s.payments.submitTransfer.mock.invocationCallOrder[0]!];
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // A taking-back too.
    const reversal = { leaseToken: "reversal-token", adjustmentId: "00000000-0000-4000-8000-000000000444", payoutId: command.payoutId, publicBookingId: command.publicBookingId, stripeTransferRef: "tr_AgentTransfer0001", amount: 100 };
    const r = setup({ prepared: { kind: "idle" }, reversals: [reversal] });
    await runAgentPayouts(r.deps);
    expect(r.repository.extendReversalLease).toHaveBeenCalledWith(reversal.adjustmentId, "reversal-token");
  });

  it("calls no Stripe for a row whose claim was lost, and goes on to the next", async () => {
    const s = setup({ lostLease: true });
    const counts = await runAgentPayouts(s.deps);
    expect(counts).toMatchObject({ skipped: 1, transferred: 0, failed: 0 });
    for (const fn of [s.payments.retrieveAccountStatus, s.payments.retrieveCharge, s.payments.submitTransfer, s.repository.begin]) expect(fn).not.toHaveBeenCalled();
    const known = setup({ lostLease: true, prepared: { kind: "reconcile", command } });
    await runAgentPayouts(known.deps);
    expect(known.payments.submitTransfer).not.toHaveBeenCalled();
    const reversal = { leaseToken: "t-reversal", adjustmentId: "00000000-0000-4000-8000-000000000444", payoutId: command.payoutId, publicBookingId: command.publicBookingId, stripeTransferRef: "tr_AgentTransfer0001", amount: 100 };
    const r = setup({ prepared: { kind: "idle" }, reversals: [reversal], lostLease: true });
    await runAgentPayouts(r.deps);
    expect(r.payments.reverseTransfer).not.toHaveBeenCalled();
  });

  it("checks the time budget before each Stripe call, not only at the start of a row", async () => {
    let ms = 0;
    const clock = () => new Date(Date.UTC(2026, 11, 10) + ms);
    const s = setup({ budgetMs: 1_000, clock });
    s.repository.prepare.mockImplementation(async () => { ms += 1_500; return destination as never; });
    const counts = await runAgentPayouts(s.deps);
    expect(counts).toMatchObject({ claimed: 1, transferred: 0, failed: 0 });
    expect(s.payments.retrieveAccountStatus).not.toHaveBeenCalled();
    expect(s.repository.extendLease).not.toHaveBeenCalled();
  });

  it("keeps one row's worst Stripe time far inside the lease", () => {
    expect(AGENT_PAYOUT_ROW_WORST_CASE_MS * 3).toBeLessThanOrEqual(AGENT_PAYOUT_LIMITS.leaseSeconds * 1000);
    expect(AGENT_PAYOUT_STRIPE_TIMEOUT_MS).toBe(20_000);
    expect(AGENT_PAYOUT_STRIPE_RETRIES).toBe(1);
  });
});
