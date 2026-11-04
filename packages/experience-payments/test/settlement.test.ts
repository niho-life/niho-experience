import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readBookingSettlement, submitSettlementTransfer, type SettlementStripeClient } from "../src/index.ts";

const BOOKING_ID = "123e4567-e89b-42d3-a456-426614174000";
const COMMAND_ID = "123e4567-e89b-42d3-a456-426614174001";
const ACCOUNT = "acct_SampleA0001";
const PI = "pi_SampleIntent0001";

function settlementStripe(overrides: Record<string, unknown> = {}): SettlementStripeClient {
  const defaults = {
    accounts: { retrieve: async () => ({ id: ACCOUNT, controller: { fees: { payer: "account" } } }) },
    paymentIntents: { retrieve: async () => ({ id: PI, metadata: { booking_id: BOOKING_ID }, latest_charge: {
      id: "ch_SampleCharge0001", payment_intent: PI, amount: 10_000, currency: "jpy",
      balance_transaction: { id: "txn_SampleBalance0001", fee: 1_860, currency: "jpy", fee_details: [
        { amount: 1_500, currency: "jpy", type: "application_fee" },
        { amount: 360, currency: "jpy", type: "stripe_fee" },
      ] },
      application_fee: { id: "fee_SampleApplication1", amount: 1_500, amount_refunded: 375 },
    } }) },
    charges: { retrieve: async () => { throw new Error("unexpected charge lookup"); } },
    balanceTransactions: { retrieve: async () => { throw new Error("unexpected balance lookup"); } },
    applicationFees: { retrieve: async () => { throw new Error("unexpected fee lookup"); } },
    refunds: { list: async () => ({ data: [
      { id: "re_SampleRefund0001", amount: 2_500, currency: "jpy", status: "succeeded" },
      { id: "re_SampleRefund0002", amount: 1_000, currency: "jpy", status: "pending" },
      { id: "re_SampleRefund0003", amount: 500, currency: "jpy", status: "failed" },
    ], has_more: false }) },
    transfers: {
      list: async () => ({ data: [], has_more: false }),
      create: async (input: Record<string, unknown>, options: Record<string, unknown>) => ({ id: "tr_SampleTransfer0001", ...input, metadata: input.metadata, request: options }),
    },
    ...overrides,
  };
  return defaults as unknown as SettlementStripeClient;
}

describe("Experience actual settlement evidence", () => {
  it("reads Stripe's real balance transaction fee and actual direct-charge refund totals", async () => {
    const evidence = await readBookingSettlement({
      publicBookingId: BOOKING_ID, connectedAccountId: ACCOUNT, paymentIntentId: PI,
      expectedGrossAmount: 10_000, expectedCurrency: "JPY", stripe: settlementStripe(),
    });
    assert.deepEqual(evidence, {
      connectedAccountId: ACCOUNT,
      currency: "JPY",
      grossAmount: 10_000,
      chargeRef: "ch_SampleCharge0001",
      balanceTransactionRef: "txn_SampleBalance0001",
      applicationFeeRef: "fee_SampleApplication1",
      feePayer: "ACCOUNT",
      processingFeeAmount: 360,
      processingFeeCurrency: "JPY",
      applicationFeeAmount: 1_500,
      applicationFeeRefunded: 375,
      successfulRefundAmount: 2_500,
      pendingRefundAmount: 1_000,
      refunds: [
        { stripeRefundRef: "re_SampleRefund0001", internalRefundId: null, amount: 2_500, currency: "JPY", status: "succeeded" },
        { stripeRefundRef: "re_SampleRefund0002", internalRefundId: null, amount: 1_000, currency: "JPY", status: "pending" },
        { stripeRefundRef: "re_SampleRefund0003", internalRefundId: null, amount: 500, currency: "JPY", status: "failed" },
      ],
      refundHistoryTruncated: false,
      issueCode: null,
    });
  });

  it("maps platform fee payer without charging the host twice", async () => {
    const stripe = settlementStripe({ accounts: { retrieve: async () => ({ id: ACCOUNT, controller: { fees: { payer: "application" } } }) } });
    const evidence = await readBookingSettlement({
      publicBookingId: BOOKING_ID, connectedAccountId: ACCOUNT, paymentIntentId: PI,
      expectedGrossAmount: 10_000, expectedCurrency: "JPY", stripe,
    });
    assert.equal(evidence.feePayer, "APPLICATION");
    assert.equal(evidence.processingFeeAmount, 360);
    assert.equal(evidence.processingFeeCurrency, "JPY");
  });

  it("separates Application Fee from the actual fee details and leaves unknown fee types for review", async () => {
    const stripe = settlementStripe({ paymentIntents: { retrieve: async () => ({ id: PI, metadata: { booking_id: BOOKING_ID }, latest_charge: {
      id: "ch_SampleCharge0001", payment_intent: PI, amount: 10_000, currency: "jpy",
      balance_transaction: { id: "txn_SampleBalance0001", fee: 1_780, currency: "jpy", fee_details: [
        { amount: 1_500, currency: "jpy", type: "application_fee" },
        { amount: 260, currency: "jpy", type: "stripe_fee" },
        { amount: 20, currency: "jpy", type: "payment_method_passthrough_fee" },
      ] },
      application_fee: { id: "fee_SampleApplication1", amount: 1_500, amount_refunded: 0 },
    } }) } });
    const evidence = await readBookingSettlement({
      publicBookingId: BOOKING_ID, connectedAccountId: ACCOUNT, paymentIntentId: PI,
      expectedGrossAmount: 10_000, expectedCurrency: "JPY", stripe,
    });
    assert.equal(evidence.processingFeeAmount, 280);
    assert.equal(evidence.issueCode, null);

    const unknown = settlementStripe({ paymentIntents: { retrieve: async () => ({ id: PI, metadata: { booking_id: BOOKING_ID }, latest_charge: {
      id: "ch_SampleCharge0001", payment_intent: PI, amount: 10_000, currency: "jpy",
      balance_transaction: { id: "txn_SampleBalance0001", fee: 1_860, currency: "jpy", fee_details: [
        { amount: 1_500, currency: "jpy", type: "application_fee" },
        { amount: 360, currency: "jpy", type: "withheld_tax" },
      ] },
      application_fee: { id: "fee_SampleApplication1", amount: 1_500, amount_refunded: 0 },
    } }) } });
    const unknownEvidence = await readBookingSettlement({
      publicBookingId: BOOKING_ID, connectedAccountId: ACCOUNT, paymentIntentId: PI,
      expectedGrossAmount: 10_000, expectedCurrency: "JPY", stripe: unknown,
    });
    assert.equal(unknownEvidence.processingFeeAmount, null);
    assert.equal(unknownEvidence.issueCode, "processing_fee_type_unknown");
  });

  it("leaves refund totals unknown when Stripe refund history is truncated", async () => {
    const stripe = settlementStripe({ refunds: { list: async () => ({ data: [{ id: "re_SampleRefund0001", amount: 2_500, currency: "jpy", status: "succeeded" }], has_more: true }) } });
    const evidence = await readBookingSettlement({
      publicBookingId: BOOKING_ID, connectedAccountId: ACCOUNT, paymentIntentId: PI,
      expectedGrossAmount: 10_000, expectedCurrency: "JPY", stripe,
    });
    assert.equal(evidence.successfulRefundAmount, null);
    assert.equal(evidence.pendingRefundAmount, null);
    assert.equal(evidence.refundHistoryTruncated, true);
    assert.equal(evidence.issueCode, "refund_history_truncated");
  });

  it("marks an unsupported connected-account fee payer for review instead of guessing", async () => {
    const stripe = settlementStripe({ accounts: { retrieve: async () => ({ id: ACCOUNT, controller: { fees: { payer: "account_on_behalf_of" } } }) } });
    const evidence = await readBookingSettlement({
      publicBookingId: BOOKING_ID, connectedAccountId: ACCOUNT, paymentIntentId: PI,
      expectedGrossAmount: 10_000, expectedCurrency: "JPY", stripe,
    });
    assert.equal(evidence.issueCode, "fee_payer_unknown");
  });

  it("recovers an existing settlement transfer by group and command metadata", async () => {
    let createCalls = 0;
    const stripe = settlementStripe({ transfers: {
      list: async () => ({ data: [{ id: "tr_SampleTransfer0001", amount: 360, currency: "jpy", destination: ACCOUNT, transfer_group: `niho-experience-settlement:${BOOKING_ID}`, metadata: { source: "niho-experience", booking_id: BOOKING_ID, settlement_command_id: COMMAND_ID } }], has_more: false }),
      create: async () => { createCalls += 1; throw new Error("must not create another transfer"); },
    } });
    const result = await submitSettlementTransfer({
      command: { commandId: COMMAND_ID, publicBookingId: BOOKING_ID, amount: 360, currency: "jpy", destinationAccountId: ACCOUNT,
        transferGroup: `niho-experience-settlement:${BOOKING_ID}`, status: "RESULT_UNKNOWN", stripeTransferRef: null, attempts: 1, createdAtUtc: "2026-10-31T12:00:00.000Z" },
      stripe,
      now: new Date("2026-11-01T00:00:00.000Z"),
    });
    assert.deepEqual(result, { kind: "already_transferred", stripeTransferRef: "tr_SampleTransfer0001" });
    assert.equal(createCalls, 0);
  });

  it("does not blindly retry an unknown transfer after the idempotency window", async () => {
    let createCalls = 0;
    const stripe = settlementStripe({ transfers: {
      list: async () => ({ data: [], has_more: false }),
      create: async () => { createCalls += 1; return {} as never; },
    } });
    const result = await submitSettlementTransfer({
      command: { commandId: COMMAND_ID, publicBookingId: BOOKING_ID, amount: 360, currency: "jpy", destinationAccountId: ACCOUNT,
        transferGroup: `niho-experience-settlement:${BOOKING_ID}`, status: "RESULT_UNKNOWN", stripeTransferRef: null, attempts: 1, createdAtUtc: "2026-10-31T12:00:00.000Z" },
      stripe,
      now: new Date("2026-11-01T12:00:00.000Z"),
    });
    assert.deepEqual(result, { kind: "review_required", issueCode: "settlement_transfer_idempotency_window_expired" });
    assert.equal(createCalls, 0);
  });

  it("uses the durable command's idempotency key for a bounded unknown-result retry", async () => {
    let optionsSeen: Record<string, unknown> | undefined;
    const stripe = settlementStripe({ transfers: {
      list: async () => ({ data: [], has_more: false }),
      create: async (input: Record<string, unknown>, options: Record<string, unknown>) => {
        optionsSeen = options;
        return { id: "tr_SampleTransfer0002", ...input };
      },
    } });
    const result = await submitSettlementTransfer({
      command: { commandId: COMMAND_ID, publicBookingId: BOOKING_ID, amount: 360, currency: "jpy", destinationAccountId: ACCOUNT,
        transferGroup: `niho-experience-settlement:${BOOKING_ID}`, status: "RESULT_UNKNOWN", stripeTransferRef: null, attempts: 1, createdAtUtc: "2026-11-01T00:00:00.000Z" },
      stripe,
      now: new Date("2026-11-01T00:05:00.000Z"),
    });
    assert.deepEqual(result, { kind: "transferred", stripeTransferRef: "tr_SampleTransfer0002" });
    assert.equal(optionsSeen?.idempotencyKey, `experience-settlement:${COMMAND_ID}`);
  });

  it("surfaces only a definitive insufficient balance as retryable", async () => {
    const stripe = settlementStripe({ transfers: {
      list: async () => ({ data: [], has_more: false }),
      create: async () => { throw Object.assign(new Error("balance unavailable"), { code: "balance_insufficient", type: "StripeInvalidRequestError" }); },
    } });
    const result = await submitSettlementTransfer({
      command: { commandId: COMMAND_ID, publicBookingId: BOOKING_ID, amount: 360, currency: "jpy", destinationAccountId: ACCOUNT,
        transferGroup: `niho-experience-settlement:${BOOKING_ID}`, status: "PREPARED", stripeTransferRef: null, attempts: 0, createdAtUtc: "2026-11-01T00:00:00.000Z" },
      stripe,
      now: new Date("2026-11-01T00:05:00.000Z"),
    });
    assert.deepEqual(result, { kind: "retryable_failed", issueCode: "settlement_transfer_balance_insufficient" });
  });
});
