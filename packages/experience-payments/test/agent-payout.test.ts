import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { retrieveAgentPayoutCharge, reverseAgentPayoutTransfer, submitAgentPayoutTransfer, type AgentPayoutStripeClient } from "../src/index.ts";

const BOOKING = "123e4567-e89b-42d3-a456-426614174000";
const PAYOUT = "123e4567-e89b-42d3-a456-426614174002";
const COMMAND = "123e4567-e89b-42d3-a456-426614174001";
const ACCOUNT = "acct_HostPayout0001";
const PI = "pi_AgentIntent0001";
const GROUP = `niho-experience-agent-payout:${BOOKING}`;
const NOW = new Date("2026-12-10T00:00:00.000Z");
const command = (over: Record<string, unknown> = {}) => ({
  commandId: COMMAND, payoutId: PAYOUT, publicBookingId: BOOKING, amount: 8_500, currency: "JPY" as const, destinationAccountId: ACCOUNT,
  chargeRef: "ch_AgentCharge0001", transferGroup: GROUP, createdAtUtc: "2026-12-09T23:50:00.000Z", ...over,
});
const stored = (over: Record<string, unknown> = {}) => ({
  id: "tr_AgentTransfer0001", amount: 8_500, currency: "jpy", destination: ACCOUNT, transfer_group: GROUP,
  metadata: { source: "niho-experience", purpose: "agent_payout", booking_id: BOOKING, payout_id: PAYOUT, command_id: COMMAND }, ...over,
});

function client(overrides: Record<string, unknown> = {}): AgentPayoutStripeClient {
  return {
    paymentIntents: { retrieve: async () => { throw new Error("unexpected"); } },
    transfers: {
      list: async () => ({ data: [], has_more: false }),
      create: async (input: Record<string, unknown>) => ({ id: "tr_AgentTransfer0002", ...input }),
      listReversals: async () => ({ data: [], has_more: false }),
      createReversal: async (_id: string, input: Record<string, unknown>) => ({ id: "trr_AgentReversal0001", ...input }),
    },
    ...overrides,
  } as unknown as AgentPayoutStripeClient;
}

describe("agent payout Transfer", () => {
  it("lists the booking's group first, then creates with the charge as source, the group, metadata and the command's idempotency key", async () => {
    const calls: string[] = [];
    let created: Record<string, unknown> | undefined;
    let options: Record<string, unknown> | undefined;
    const stripe = client({ transfers: {
      list: async (input: Record<string, unknown>) => { calls.push(`list:${String(input.transfer_group)}`); return { data: [], has_more: false }; },
      create: async (input: Record<string, unknown>, opts: Record<string, unknown>) => { calls.push("create"); created = input; options = opts; return { id: "tr_AgentTransfer0002", ...input }; },
    } });
    const answer = await submitAgentPayoutTransfer({ command: command(), stripe, now: NOW });
    assert.deepEqual(answer, { kind: "transferred", stripeTransferRef: "tr_AgentTransfer0002" });
    assert.deepEqual(calls, [`list:${GROUP}`, "create"]);
    assert.deepEqual(created, {
      amount: 8_500, currency: "jpy", destination: ACCOUNT, source_transaction: "ch_AgentCharge0001", transfer_group: GROUP,
      metadata: { source: "niho-experience", purpose: "agent_payout", booking_id: BOOKING, payout_id: PAYOUT, command_id: COMMAND },
    });
    assert.equal(options?.idempotencyKey, `experience-agent-payout:${COMMAND}`);
  });

  it("adopts the transfer already in the group and never creates another", async () => {
    let creates = 0;
    const stripe = client({ transfers: { list: async () => ({ data: [stored()], has_more: false }), create: async () => { creates += 1; return {}; } } });
    assert.deepEqual(await submitAgentPayoutTransfer({ command: command(), stripe, now: NOW }), { kind: "already_transferred", stripeTransferRef: "tr_AgentTransfer0001" });
    assert.equal(creates, 0);
  });

  it("sends nothing when the group holds a mismatching, foreign or duplicate transfer, or the list is truncated", async () => {
    const run = async (data: unknown[], has_more = false) => {
      let creates = 0;
      const stripe = client({ transfers: { list: async () => ({ data, has_more }), create: async () => { creates += 1; return {}; } } });
      const answer = await submitAgentPayoutTransfer({ command: command(), stripe, now: NOW });
      assert.equal(creates, 0);
      return answer;
    };
    assert.deepEqual(await run([stored({ amount: 100 })]), { kind: "review_required", issueCode: "agent_payout_transfer_mismatch" });
    assert.deepEqual(await run([stored({ destination: "acct_Other00000001" })]), { kind: "review_required", issueCode: "agent_payout_transfer_mismatch" });
    assert.deepEqual(await run([stored({ metadata: { source: "someone-else" } })]), { kind: "review_required", issueCode: "agent_payout_group_occupied" });
    assert.deepEqual(await run([stored(), stored({ id: "tr_AgentTransfer0009" })]), { kind: "review_required", issueCode: "agent_payout_duplicate_transfers" });
    assert.deepEqual(await run([], true), { kind: "review_required", issueCode: "agent_payout_history_truncated" });
  });

  it("does not create again after the 23-hour window", async () => {
    let creates = 0;
    const stripe = client({ transfers: { list: async () => ({ data: [], has_more: false }), create: async () => { creates += 1; return {}; } } });
    const answer = await submitAgentPayoutTransfer({ command: command({ createdAtUtc: "2026-12-08T00:00:00.000Z" }), stripe, now: NOW });
    assert.deepEqual(answer, { kind: "review_required", issueCode: "agent_payout_idempotency_window_expired" });
    assert.equal(creates, 0);
  });

  it("refuses the settlement's group and malformed commands", async () => {
    await assert.rejects(submitAgentPayoutTransfer({ command: command({ transferGroup: `niho-experience-settlement:${BOOKING}` }), stripe: client(), now: NOW }), /settlement/);
    await assert.rejects(submitAgentPayoutTransfer({ command: command({ transferGroup: "other" }), stripe: client(), now: NOW }), /malformed/);
    await assert.rejects(submitAgentPayoutTransfer({ command: command({ amount: 0 }), stripe: client(), now: NOW }), /malformed/);
    await assert.rejects(submitAgentPayoutTransfer({ command: command({ chargeRef: "pi_x" }), stripe: client(), now: NOW }), /malformed/);
  });

  it("classifies Stripe's refusals: a missing transfers capability waits for the account, others stop; an unknown error is thrown", async () => {
    const refuse = (code: string, type = "StripeInvalidRequestError") => client({ transfers: {
      list: async () => ({ data: [], has_more: false }),
      create: async () => { throw Object.assign(new Error("refused"), { type, code }); },
    } });
    assert.deepEqual(await submitAgentPayoutTransfer({ command: command(), stripe: refuse("insufficient_capabilities_for_transfer"), now: NOW }), { kind: "account_not_ready", issueCode: "agent_payout_insufficient_capabilities_for_transfer" });
    assert.deepEqual(await submitAgentPayoutTransfer({ command: command(), stripe: refuse("amount_too_large"), now: NOW }), { kind: "review_required", issueCode: "agent_payout_transfer_amount_too_large" });
    await assert.rejects(submitAgentPayoutTransfer({ command: command(), stripe: refuse("x", "StripeConnectionError"), now: NOW }), /refused/);
  });
});

describe("agent payout Reversal", () => {
  const ADJUSTMENT = "123e4567-e89b-42d3-a456-426614174009";
  const input = { transferRef: "tr_AgentTransfer0001", adjustmentId: ADJUSTMENT, amount: 2_550 };

  it("lists the transfer's reversals first, then creates one with the adjustment's idempotency key", async () => {
    const calls: string[] = [];
    let options: Record<string, unknown> | undefined;
    let params: Record<string, unknown> | undefined;
    const stripe = client({ transfers: {
      listReversals: async () => { calls.push("list"); return { data: [], has_more: false }; },
      createReversal: async (_id: string, p: Record<string, unknown>, o: Record<string, unknown>) => { calls.push("create"); params = p; options = o; return { id: "trr_AgentReversal0001", amount: p.amount }; },
    } });
    assert.deepEqual(await reverseAgentPayoutTransfer({ ...input, stripe }), { kind: "reversed", stripeReversalRef: "trr_AgentReversal0001" });
    assert.deepEqual(calls, ["list", "create"]);
    assert.equal(options?.idempotencyKey, `experience-agent-payout-reversal:${ADJUSTMENT}`);
    assert.deepEqual(params?.metadata, { source: "niho-experience", purpose: "agent_payout_reversal", adjustment_id: ADJUSTMENT });
  });

  it("adopts a reversal that names the adjustment, and stops on a different amount", async () => {
    let creates = 0;
    const listed = (amount: number) => client({ transfers: {
      listReversals: async () => ({ data: [{ id: "trr_AgentReversal0007", amount, metadata: { adjustment_id: ADJUSTMENT } }], has_more: false }),
      createReversal: async () => { creates += 1; return {}; },
    } });
    assert.deepEqual(await reverseAgentPayoutTransfer({ ...input, stripe: listed(2_550) }), { kind: "reversed", stripeReversalRef: "trr_AgentReversal0007" });
    assert.deepEqual(await reverseAgentPayoutTransfer({ ...input, stripe: listed(1) }), { kind: "review_required", issueCode: "agent_payout_reversal_mismatch" });
    assert.equal(creates, 0);
  });

  it("classifies an insufficient balance apart from other refusals, and throws on an unknown failure", async () => {
    const refuse = (code: string, type = "StripeInvalidRequestError") => client({ transfers: {
      listReversals: async () => ({ data: [], has_more: false }),
      createReversal: async () => { throw Object.assign(new Error("refused"), { type, code }); },
    } });
    assert.deepEqual(await reverseAgentPayoutTransfer({ ...input, stripe: refuse("balance_insufficient") }), { kind: "insufficient_balance" });
    assert.deepEqual(await reverseAgentPayoutTransfer({ ...input, stripe: refuse("amount_too_large") }), { kind: "review_required", issueCode: "agent_payout_reversal_amount_too_large" });
    await assert.rejects(reverseAgentPayoutTransfer({ ...input, stripe: refuse("x", "StripeAPIError") }), /refused/);
    await assert.rejects(reverseAgentPayoutTransfer({ ...input, amount: 0, stripe: client() }), /positive/);
  });
});

describe("agent payout Charge check", () => {
  const intent = (over: Record<string, unknown> = {}, charge: Record<string, unknown> | null = {}) => client({ paymentIntents: { retrieve: async (id: string, params: Record<string, unknown>) => {
    assert.deepEqual(params, { expand: ["latest_charge"] });
    return { id, status: "succeeded", transfer_group: GROUP, latest_charge: charge === null ? "ch_AgentCharge0001" : {
      id: "ch_AgentCharge0001", status: "succeeded", paid: true, captured: true, amount: 10_000, currency: "jpy", payment_intent: PI, transfer_group: GROUP, amount_refunded: 0, disputed: false, ...charge,
    }, ...over };
  } } });
  const check = (stripe: AgentPayoutStripeClient, expectedAmount = 10_000, knownRefundedAmount = 0, knownDisputeCount = 0) => retrieveAgentPayoutCharge({ paymentIntentId: PI, publicBookingId: BOOKING, expectedAmount, knownRefundedAmount, knownDisputeCount, stripe });

  it("confirms the Charge's ID, amount and currency", async () => {
    assert.deepEqual(await check(intent()), { kind: "ok", chargeRef: "ch_AgentCharge0001", amount: 10_000, currency: "JPY" });
  });

  it("names what does not match", async () => {
    assert.deepEqual(await check(intent(), 9_000), { kind: "mismatch", issueCode: "agent_payout_charge_amount_mismatch" });
    assert.deepEqual(await check(intent({}, { currency: "usd" })), { kind: "mismatch", issueCode: "agent_payout_charge_amount_mismatch" });
    assert.deepEqual(await check(intent({}, { status: "failed" })), { kind: "mismatch", issueCode: "agent_payout_charge_not_succeeded" });
    assert.deepEqual(await check(intent({ status: "requires_action" })), { kind: "mismatch", issueCode: "agent_payout_charge_not_succeeded" });
    assert.deepEqual(await check(intent({}, { payment_intent: "pi_Another000001" })), { kind: "mismatch", issueCode: "agent_payout_payment_mismatch" });
    assert.deepEqual(await check(intent({ transfer_group: "other" })), { kind: "mismatch", issueCode: "agent_payout_transfer_group_mismatch" });
    assert.deepEqual(await check(intent({}, null)), { kind: "mismatch", issueCode: "agent_payout_charge_missing" });
  });

  it("does not send from a Charge refunded outside this service, or disputed with no dispute row yet", async () => {
    // Refunded 2,000 in Stripe's Dashboard while our records know of none; known refunds up to that amount are fine.
    assert.deepEqual(await check(intent({}, { amount_refunded: 2_000 })), { kind: "mismatch", issueCode: "agent_payout_charge_refunded_outside" });
    assert.deepEqual(await check(intent({}, { amount_refunded: 2_000 }), 10_000, 2_000), { kind: "ok", chargeRef: "ch_AgentCharge0001", amount: 10_000, currency: "JPY" });
    assert.deepEqual(await check(intent({}, { amount_refunded: 2_500 }), 10_000, 2_000), { kind: "mismatch", issueCode: "agent_payout_charge_refunded_outside" });
    assert.deepEqual(await check(intent({}, { disputed: true })), { kind: "mismatch", issueCode: "agent_payout_charge_disputed" });
    // Stripe's `disputed` stays true once decided: with a dispute row in our ledger (won, closed, partly lost) the ledger's calculation decides, not this flag.
    assert.deepEqual(await check(intent({}, { disputed: true }), 10_000, 0, 1), { kind: "ok", chargeRef: "ch_AgentCharge0001", amount: 10_000, currency: "JPY" });
  });

  it("when paused only looks the transfer up: an existing one is adopted, none is created", async () => {
    let creates = 0;
    const none = client({ transfers: { list: async () => ({ data: [], has_more: false }), create: async () => { creates += 1; return {}; } } });
    assert.deepEqual(await submitAgentPayoutTransfer({ command: command(), stripe: none, now: NOW, create: false }), { kind: "unknown" });
    const some = client({ transfers: { list: async () => ({ data: [stored()], has_more: false }), create: async () => { creates += 1; return {}; } } });
    assert.deepEqual(await submitAgentPayoutTransfer({ command: command(), stripe: some, now: NOW, create: false }), { kind: "already_transferred", stripeTransferRef: "tr_AgentTransfer0001" });
    assert.equal(creates, 0);
  });
});
