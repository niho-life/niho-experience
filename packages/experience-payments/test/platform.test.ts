import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Stripe from "stripe";
import type { BookingRecord, RefundSubmission } from "@niho-experience/experience-store";
import {
  createPlatformCheckout,
  expireDirectCheckout,
  expirePlatformCheckout,
  retrievePlatformAccount,
  retrievePlatformCheckout,
  submitBookingRefund,
  verifyPlatformCheckoutWebhook,
  type PaymentsStripeClient,
} from "../src/index.ts";

const BOOKING_ID = "123e4567-e89b-42d3-a456-426614174000";
const PLATFORM_ID = "acct_PlatformSynthetic1";
const SECRET = "whsec_platform_synthetic_secret";
const NOW = new Date("2026-11-01T00:00:00.000Z");

function booking(): BookingRecord {
  return {
    publicBookingId: BOOKING_ID, providerId: "provider-synthetic", productId: "product-synthetic",
    occurrenceId: "occurrence-synthetic", status: "HOLD", seats: 1, idempotencyKey: "request-synthetic",
    holdExpiresAtUtc: "2026-11-01T00:45:00.000Z",
    occurrenceSnapshot: {
      occurrenceId: "occurrence-synthetic", ruleId: "rule-synthetic", sourceLocalDate: "2026-11-02",
      localDate: "2026-11-02", localStartTime: "10:30", timeZone: "Asia/Tokyo",
      startUtc: "2026-11-02T01:30:00.000Z", endUtc: "2026-11-02T03:00:00.000Z",
      capacityAtAcceptance: 6, seats: 1, acceptedAtUtc: NOW.toISOString(),
    },
    pricingSnapshot: {
      currency: "JPY", unitAmount: 10_000, seats: 1, totalAmount: 10_000,
      cancellationTermsRef: "terms-v1",
      platformFee: { amount: 2_000, basisPoints: 2_000, supportEnabled: false, salesPlan: "MANAGED_20" },
    },
    sellerSnapshot: {
      experienceProviderId: "provider-synthetic", nihoAccountRef: PLATFORM_ID,
      stripeConnectAccountRef: PLATFORM_ID, displayName: "Synthetic Provider",
      chargeMode: "PLATFORM", salesPlan: "MANAGED_20", salesPlanRevision: 1,
      feeBasisPoints: 2_000, sellerDisclosureUrl: "https://example.test/legal",
      agreementVersion: "managed-v1", paymentDueDays: 14,
    },
    createdAtUtc: NOW.toISOString(),
  };
}

/** 代理受領 (#725): the host sells (sellerParty PROVIDER), NIHO's receiving party takes the payment. */
function agentBooking(over: Record<string, unknown> = {}): BookingRecord {
  const base = booking();
  return {
    ...base,
    pricingSnapshot: { ...base.pricingSnapshot, platformFee: { amount: 1_500, basisPoints: 1_500, supportEnabled: true, salesPlan: "SUPPORTED_15" } },
    sellerSnapshot: {
      ...base.sellerSnapshot, nihoAccountRef: `agt_${"a".repeat(32)}`, displayName: "合成 販売者", salesPlan: "SUPPORTED_15", feeBasisPoints: 1_500,
      sellerParty: "PROVIDER", payoutDelayDays: 3, receivingAgentName: "Synthetic NIHO Receiver KK", ...over,
    },
  };
}

function signed(event: Record<string, unknown>) {
  const rawBody = Buffer.from(JSON.stringify(event));
  const stripe = new Stripe("sk_test_synthetic");
  return {
    rawBody,
    stripeSignature: Stripe.webhooks.generateTestHeaderString({ payload: rawBody.toString(), secret: SECRET, timestamp: Math.floor(Date.now() / 1000) }),
    endpointSecret: SECRET, expectedPlatformAccountId: PLATFORM_ID, stripe,
  };
}

function checkoutEvent(account?: string, paymentStatus = "paid") {
  return {
    id: "evt_PlatformSynthetic1", object: "event", api_version: "2025-12-15.clover",
    created: 1_793_494_200, livemode: false, pending_webhooks: 1, request: null,
    type: "checkout.session.completed", ...(account === undefined ? {} : { account }),
    data: { object: {
      id: "cs_test_platform_synthetic", object: "checkout.session", mode: "payment", status: "complete",
      payment_status: paymentStatus, amount_total: 10_000, currency: "jpy", payment_intent: "pi_PlatformSynthetic1",
      metadata: { source: "niho-experience-platform", booking_id: BOOKING_ID },
    } },
  };
}

describe("managed platform payment boundary", () => {
  it("creates Checkout on the key's own account with no account header or application fee", async () => {
    const calls: unknown[][] = [];
    const stripe = { checkout: { sessions: { create: async (...args: unknown[]) => {
      calls.push(args); return { id: "cs_test_platform_synthetic", url: "https://checkout.stripe.com/c/pay/platform" };
    } } } } as unknown as PaymentsStripeClient;
    await createPlatformCheckout({ booking: booking(), returnOrigin: "https://example.test", returnPath: "/return", stripe, now: NOW });
    const [params, options] = calls[0]! as [Record<string, unknown>, Record<string, unknown>];
    assert.deepEqual(options, { idempotencyKey: `experience-platform-checkout:${BOOKING_ID}` });
    assert.equal("stripeAccount" in options, false);
    assert.deepEqual(params.metadata, { source: "niho-experience-platform", booking_id: BOOKING_ID });
    assert.equal("application_fee_amount" in (params.payment_intent_data as Record<string, unknown>), false);
    assert.equal("payment_method_types" in params, false, "platform Checkout uses Stripe's dynamic payment methods");
  });

  it("creates the same platform Checkout for agent sales, plus a transfer group and the seller-and-receiver notice (ja and en)", async () => {
    const run = async (locale: "auto" | "ja", target: BookingRecord) => {
      const calls: unknown[][] = [];
      const stripe = { checkout: { sessions: { create: async (...args: unknown[]) => {
        calls.push(args); return { id: "cs_test_platform_synthetic", url: "https://checkout.stripe.com/c/pay/platform" };
      } } } } as unknown as PaymentsStripeClient;
      await createPlatformCheckout({ booking: target, returnOrigin: "https://example.test", returnPath: "/return", locale, stripe, now: NOW });
      return calls[0]! as [Record<string, unknown>, Record<string, unknown>];
    };
    const [ja, jaOptions] = await run("ja", agentBooking());
    assert.deepEqual(jaOptions, { idempotencyKey: `experience-platform-checkout:${BOOKING_ID}` }, "no account header, the booking's key");
    assert.deepEqual(ja.metadata, { source: "niho-experience-platform", booking_id: BOOKING_ID }, "the platform webhook's two keys");
    const intent = ja.payment_intent_data as Record<string, unknown>;
    assert.equal("application_fee_amount" in intent, false);
    assert.deepEqual(intent.metadata, { source: "niho-experience-platform", booking_id: BOOKING_ID });
    assert.equal(intent.transfer_group, `niho-experience-agent-payout:${BOOKING_ID}`);
    assert.deepEqual(ja.custom_text, { submit: { message: "販売者：合成 販売者。お支払いはSynthetic NIHO Receiver KKが販売者に代わって受け取ります。" } });
    const [en] = await run("auto", agentBooking());
    assert.deepEqual(en.custom_text, { submit: { message: "Seller: 合成 販売者. Your payment is received by Synthetic NIHO Receiver KK on the seller's behalf." } });
    // The 20% booking's parameters are unchanged: no transfer group, no notice.
    const [managed] = await run("ja", booking());
    assert.equal("custom_text" in managed, false);
    assert.equal("transfer_group" in (managed.payment_intent_data as Record<string, unknown>), false);
    // A platform charge that is neither a 20% sale nor an agent sale is refused.
    const stripe = { checkout: { sessions: { create: async () => { throw new Error("Stripe must not be called"); } } } } as unknown as PaymentsStripeClient;
    for (const bad of [{ sellerParty: undefined }, { feeBasisPoints: 1_000 }, { salesPlan: "INDEPENDENT_10", feeBasisPoints: 1_000 }, { receivingAgentName: undefined }]) {
      await assert.rejects(() => createPlatformCheckout({ booking: agentBooking(bad), returnOrigin: "https://example.test", returnPath: "/return", stripe, now: NOW }), /not a managed platform charge|no seller or receiving party name/);
    }
  });

  it("writes the Checkout notice for each locale, drops control characters and cuts a long name at 1200 characters", async () => {
    const message = async (locale: "auto" | "ja", over: Record<string, unknown>) => {
      let params: Record<string, unknown> = {};
      const stripe = { checkout: { sessions: { create: async (given: Record<string, unknown>) => {
        params = given; return { id: "cs_test_platform_synthetic", url: "https://checkout.stripe.com/c/pay/platform" };
      } } } } as unknown as PaymentsStripeClient;
      await createPlatformCheckout({ booking: agentBooking(over), returnOrigin: "https://example.test", returnPath: "/return", locale, stripe, now: NOW });
      return (params.custom_text as { submit: { message: string } }).submit.message;
    };
    assert.equal(await message("auto", { displayName: "Sample Host", receivingAgentName: "NIHO KK" }), "Seller: Sample Host. Your payment is received by NIHO KK on the seller's behalf.");
    assert.equal(await message("ja", { displayName: "Sample Host", receivingAgentName: "NIHO KK" }), "販売者：Sample Host。お支払いはNIHO KKが販売者に代わって受け取ります。");
    assert.equal(await message("auto", { displayName: "A\u0000B\r\nC\u007fD\u2028E", receivingAgentName: "  NIHO\tKK  " }), "Seller: A B C D E. Your payment is received by NIHO KK on the seller's behalf.");
    for (const locale of ["auto", "ja"] as const) {
      const cut = await message(locale, { displayName: "x".repeat(5_000) });
      assert.equal(cut.length, 1_200);
      assert.ok(cut.endsWith("…"));
    }
  });

  it("accepts an agent-sales Checkout Session in the platform webhook", () => {
    const event = verifyPlatformCheckoutWebhook(signed(checkoutEvent()));
    assert.ok(event && "publicBookingId" in event && event.publicBookingId === BOOKING_ID, "metadata is the platform's two keys, not the sale kind");
  });

  it("verifies the key's current account instead of accepting an arbitrary connected account", async () => {
    const calls: unknown[][] = [];
    const stripe = { accounts: { retrieveCurrent: async (...args: unknown[]) => {
      calls.push(args); return { id: PLATFORM_ID, charges_enabled: true, details_submitted: true, country: "JP", default_currency: "jpy" };
    } } } as unknown as Pick<Stripe, "accounts">;
    assert.equal((await retrievePlatformAccount({ expectedAccountId: PLATFORM_ID, stripe })).id, PLATFORM_ID);
    assert.deepEqual(calls, [[]]);
  });

  it("retrieves only the booking's trusted Stripe-hosted platform Checkout URL and real expiry", async () => {
    const stripe = { checkout: { sessions: { retrieve: async () => ({
      id: "cs_test_platform_synthetic", status: "open", url: "https://checkout.stripe.com/c/pay/platform",
      expires_at: 1_793_493_600, metadata: { source: "niho-experience-platform", booking_id: BOOKING_ID },
    }) } } } as unknown as PaymentsStripeClient;
    assert.deepEqual(await retrievePlatformCheckout({ booking: booking(), checkoutSessionId: "cs_test_platform_synthetic", stripe }), {
      status: "open", checkoutUrl: "https://checkout.stripe.com/c/pay/platform", expiresAtUtc: "2026-11-01T00:40:00.000Z",
    });
    const untrusted = { checkout: { sessions: { retrieve: async () => ({
      id: "cs_test_platform_synthetic", status: "open", url: "https://checkout.stripe.example/pay/platform",
      expires_at: 1_793_493_600, metadata: { source: "niho-experience-platform", booking_id: BOOKING_ID },
    }) } } } as unknown as PaymentsStripeClient;
    await assert.rejects(() => retrievePlatformCheckout({ booking: booking(), checkoutSessionId: "cs_test_platform_synthetic", stripe: untrusted }), /untrusted Checkout URL/);
  });

  it("expires an old platform Session without a connected-account header", async () => {
    const calls: unknown[][] = [];
    const stripe = { checkout: { sessions: {
      retrieve: async (...args: unknown[]) => { calls.push(["retrieve", ...args]); return { id: "cs_test_platform_synthetic", status: "open", payment_status: "unpaid", metadata: { source: "niho-experience-platform", booking_id: BOOKING_ID } }; },
      expire: async (...args: unknown[]) => { calls.push(["expire", ...args]); return { status: "expired" }; },
    } } } as unknown as PaymentsStripeClient;
    assert.equal(await expirePlatformCheckout({ booking: booking(), checkoutSessionId: "cs_test_platform_synthetic", stripe }), "expired");
    assert.deepEqual(calls, [["retrieve", "cs_test_platform_synthetic"], ["expire", "cs_test_platform_synthetic"]]);
  });

  it("expires an old Direct Session only on its original connected account", async () => {
    const calls: unknown[][] = [];
    const direct = { ...booking(), sellerSnapshot: { ...booking().sellerSnapshot, chargeMode: "CONNECT_DIRECT" as const, salesPlan: "SUPPORTED_15" as const, stripeConnectAccountRef: "acct_OwnerSynthetic0001" } };
    const stripe = { checkout: { sessions: {
      retrieve: async (...args: unknown[]) => { calls.push(["retrieve", ...args]); return { id: "cs_test_direct_synthetic", status: "open", payment_status: "unpaid", metadata: { source: "niho-experience", booking_id: BOOKING_ID } }; },
      expire: async (...args: unknown[]) => { calls.push(["expire", ...args]); return { status: "expired" }; },
    } } } as unknown as PaymentsStripeClient;
    assert.equal(await expireDirectCheckout({ booking: direct, checkoutSessionId: "cs_test_direct_synthetic", stripe }), "expired");
    const options = { stripeAccount: "acct_OwnerSynthetic0001" };
    assert.deepEqual(calls, [["retrieve", "cs_test_direct_synthetic", undefined, options], ["expire", "cs_test_direct_synthetic", undefined, options]]);
  });

  it("accepts a signed account-level event and rejects connected-account mixing", () => {
    assert.deepEqual(verifyPlatformCheckoutWebhook(signed(checkoutEvent())), {
      eventId: "evt_PlatformSynthetic1", eventType: "checkout.session.completed",
      eventOccurredAtUtc: "2026-11-01T00:50:00.000Z", connectedAccountId: PLATFORM_ID,
      publicBookingId: BOOKING_ID, paymentIntentRef: "pi_PlatformSynthetic1", amountTotal: 10_000, currency: "JPY",
    });
    assert.throws(() => verifyPlatformCheckoutWebhook(signed(checkoutEvent("acct_ConnectedSynthetic1"))), /Connected-account events/);
    assert.equal(verifyPlatformCheckoutWebhook(signed(checkoutEvent(undefined, "unpaid"))), null, "unpaid completed is acknowledged without confirming the booking");
  });

  it("refunds the original platform payment with no account header or application fee reversal", async () => {
    const calls = { list: [] as unknown[][], create: [] as unknown[][] };
    const stripe = { refunds: {
      list: async (...args: unknown[]) => { calls.list.push(args); return { data: [] }; },
      create: async (...args: unknown[]) => { calls.create.push(args); return { id: "re_PlatformSynthetic1", amount: 2_000, status: "succeeded", failure_reason: null }; },
    } } as unknown as PaymentsStripeClient;
    const refund: RefundSubmission = {
      refundId: "6f1c2b9e-3a4d-4c5e-8f70-112233445566", publicBookingId: BOOKING_ID,
      connectedAccountId: PLATFORM_ID, stripePaymentRef: "pi_PlatformSynthetic1", chargeMode: "PLATFORM",
      kind: "PARTIAL", amount: 2_000, currency: "JPY", refundApplicationFee: false,
    };
    await submitBookingRefund({ refund, stripe });
    assert.deepEqual(calls.list[0], [{ payment_intent: "pi_PlatformSynthetic1", limit: 100 }, {}]);
    const [params, options] = calls.create[0]! as [Record<string, unknown>, Record<string, unknown>];
    assert.equal("refund_application_fee" in params, false);
    assert.equal("stripeAccount" in options, false);
    assert.deepEqual(params.metadata, { source: "niho-experience-platform", booking_id: BOOKING_ID, refund_id: refund.refundId });
  });
});
