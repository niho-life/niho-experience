import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Stripe from "stripe";
import type { BookingRecord } from "@niho-experience/experience-store";
import {
  createDirectCheckout,
  ExperiencePaymentsValidationError,
  verifyDirectCheckoutWebhook,
  type PaymentsStripeClient,
} from "../src/index.ts";

const BOOKING_ID = "123e4567-e89b-42d3-a456-426614174000";
const NOW = new Date("2026-11-01T00:00:00.000Z");

function booking(overrides: Partial<BookingRecord> = {}): BookingRecord {
  return {
    publicBookingId: BOOKING_ID,
    providerId: "provider-synthetic",
    productId: "product-synthetic",
    occurrenceId: "occurrence-synthetic",
    status: "HOLD",
    seats: 2,
    idempotencyKey: "request-synthetic",
    holdExpiresAtUtc: "2026-11-01T00:45:00.000Z",
    occurrenceSnapshot: {
      occurrenceId: "occurrence-synthetic",
      ruleId: "rule-synthetic",
      sourceLocalDate: "2026-11-02",
      localDate: "2026-11-02",
      localStartTime: "10:30",
      timeZone: "Asia/Tokyo",
      startUtc: "2026-11-02T01:30:00.000Z",
      endUtc: "2026-11-02T03:00:00.000Z",
      capacityAtAcceptance: 6,
      seats: 2,
      acceptedAtUtc: NOW.toISOString(),
    },
    pricingSnapshot: {
      currency: "JPY",
      unitAmount: 4_000,
      seats: 2,
      totalAmount: 8_000,
      cancellationTermsRef: "terms-v1",
    },
    sellerSnapshot: {
      experienceProviderId: "provider-synthetic",
      nihoAccountRef: "niho-synthetic",
      stripeConnectAccountRef: "acct_Synthetic123",
      displayName: "Synthetic Host",
    },
    createdAtUtc: NOW.toISOString(),
    ...overrides,
  };
}

describe("createDirectCheckout", () => {
  it("creates a card-only Direct Checkout Session entirely from booking snapshots", async () => {
    let receivedParams: Stripe.Checkout.SessionCreateParams | undefined;
    let receivedOptions: Stripe.RequestOptions | undefined;
    const stripe = {
      checkout: {
        sessions: {
          create: async (params: Stripe.Checkout.SessionCreateParams, options?: Stripe.RequestOptions) => {
            receivedParams = params;
            receivedOptions = options;
            return { id: "cs_test_synthetic", url: "https://checkout.stripe.com/c/pay/synthetic" };
          },
        },
      },
    } as unknown as PaymentsStripeClient;

    const result = await createDirectCheckout({
      booking: booking(),
      applicationFeeAmount: 800,
      returnOrigin: "https://experience.example.test",
      returnPath: "/booking/return?source=checkout",
      stripe,
      now: NOW,
    });

    assert.deepEqual(result, {
      checkoutSessionId: "cs_test_synthetic",
      checkoutUrl: "https://checkout.stripe.com/c/pay/synthetic",
    });
    assert.equal(receivedOptions?.stripeAccount, "acct_Synthetic123");
    assert.equal(receivedOptions?.idempotencyKey, `experience-checkout:${BOOKING_ID}`);
    assert.equal(receivedParams?.mode, "payment");
    assert.deepEqual(receivedParams?.payment_method_types, ["card"]);
    assert.equal("integration_identifier" in (receivedParams ?? {}), false);
    assert.equal(receivedParams?.expires_at, 1_793_493_840);
    assert.equal(receivedParams?.success_url, "https://experience.example.test/booking/return?source=checkout");
    assert.deepEqual(receivedParams?.metadata, { source: "niho-experience", booking_id: BOOKING_ID });
    assert.deepEqual(receivedParams?.payment_intent_data, { application_fee_amount: 800 });
    assert.deepEqual(receivedParams?.line_items, [{
      quantity: 1,
      price_data: {
        currency: "jpy",
        unit_amount: 8_000,
        product_data: { name: "Experience booking — 2026-11-02 10:30" },
      },
    }]);
    assert.equal(JSON.stringify(receivedParams).includes("Synthetic Host"), false);
  });

  it("charges a guest booking's snapshot total when children have their own price (#285)", async () => {
    let receivedParams: Stripe.Checkout.SessionCreateParams | undefined;
    const stripe = {
      checkout: { sessions: { create: async (params: Stripe.Checkout.SessionCreateParams) => {
        receivedParams = params;
        return { id: "cs_test_synthetic", url: "https://checkout.stripe.com/c/pay/synthetic" };
      } } },
    } as unknown as PaymentsStripeClient;
    const base = booking();
    const family = booking({
      seats: 3,
      occurrenceSnapshot: { ...base.occurrenceSnapshot, seats: 3 },
      pricingSnapshot: {
        ...base.pricingSnapshot, seats: 3, totalAmount: 10_000,
        breakdown: { adultCount: 2, childCount: 1, childUnitAmount: 2_000 }, cancellationPolicy: "FREE_UNTIL_24H",
      },
    });
    const input = { applicationFeeAmount: 1_000, returnOrigin: "https://experience.example.test", returnPath: "/booking/return", stripe, now: NOW };
    await createDirectCheckout({ ...input, booking: family });
    assert.equal(receivedParams?.line_items?.[0]?.price_data?.unit_amount, 10_000);
    // A breakdown that does not add up to the seats or the total is refused.
    for (const breakdown of [
      { adultCount: 2, childCount: 2, childUnitAmount: 2_000 },
      { adultCount: 2, childCount: 1, childUnitAmount: 1_000 },
      { adultCount: 2, childCount: 1, childUnitAmount: null },
    ]) {
      await assert.rejects(
        createDirectCheckout({ ...input, booking: { ...family, pricingSnapshot: { ...family.pricingSnapshot, breakdown } } }),
        /total is inconsistent/,
      );
    }
  });

  it("rejects holds that cannot satisfy Stripe's minimum expiry plus the safety margin", async () => {
    await assert.rejects(
      createDirectCheckout({
        booking: booking({ holdExpiresAtUtc: "2026-11-01T00:30:59.000Z" }),
        applicationFeeAmount: 800,
        returnOrigin: "https://experience.example.test",
        returnPath: "/booking/return",
        stripe: {} as PaymentsStripeClient,
        now: NOW,
      }),
      ExperiencePaymentsValidationError,
    );
  });

  it("rejects unsafe return targets and invalid application fees", async () => {
    const base = {
      booking: booking(),
      returnOrigin: "https://experience.example.test",
      returnPath: "/booking/return",
      stripe: {} as PaymentsStripeClient,
      now: NOW,
    };
    await assert.rejects(createDirectCheckout({ ...base, applicationFeeAmount: 8_000 }), /less than the booking total/);
    await assert.rejects(
      createDirectCheckout({ ...base, applicationFeeAmount: 800, returnPath: "//attacker.example/return" }),
      /same-origin absolute path/,
    );
    await assert.rejects(
      createDirectCheckout({ ...base, applicationFeeAmount: 800, returnOrigin: "http://experience.example.test" }),
      /must use HTTPS/,
    );
  });
});

interface SyntheticEventOptions {
  type?: string;
  account?: string;
  paymentStatus?: string;
  metadata?: Record<string, string> | null;
  amountTotal?: number | null;
  currency?: string | null;
  paymentIntent?: string | null | { id: string };
}

function syntheticEvent(options: SyntheticEventOptions = {}): Record<string, unknown> {
  return {
    id: "evt_Synthetic123",
    object: "event",
    api_version: "2025-12-15.clover",
    created: 1_793_494_200,
    livemode: false,
    pending_webhooks: 1,
    request: null,
    type: options.type ?? "checkout.session.completed",
    account: options.account === undefined ? "acct_Synthetic123" : options.account,
    data: {
      object: {
        id: "cs_test_synthetic",
        object: "checkout.session",
        mode: "payment",
        payment_status: options.paymentStatus ?? "paid",
        metadata: options.metadata === undefined ? { source: "niho-experience", booking_id: BOOKING_ID } : options.metadata,
        amount_total: options.amountTotal === undefined ? 8_000 : options.amountTotal,
        currency: options.currency === undefined ? "jpy" : options.currency,
        payment_intent: options.paymentIntent === undefined ? "pi_Synthetic123" : options.paymentIntent,
      },
    },
  };
}

function signedPayload(event: Record<string, unknown>): {
  rawBody: Uint8Array;
  stripeSignature: string;
  endpointSecret: string;
  stripe: PaymentsStripeClient;
} {
  const stripe = new Stripe("synthetic-platform-key-only");
  const payload = JSON.stringify(event);
  const endpointSecret = "synthetic-endpoint-secret-only";
  const stripeSignature = stripe.webhooks.generateTestHeaderString({
    payload,
    secret: endpointSecret,
    timestamp: Math.floor(Date.now() / 1_000),
  });
  return { rawBody: Buffer.from(payload), stripeSignature, endpointSecret, stripe };
}

describe("verifyDirectCheckoutWebhook", () => {
  it("verifies raw bytes and returns only the payment ledger fields", () => {
    assert.deepEqual(verifyDirectCheckoutWebhook(signedPayload(syntheticEvent())), {
      eventId: "evt_Synthetic123",
      eventType: "checkout.session.completed",
      eventOccurredAtUtc: "2026-11-01T00:50:00.000Z",
      connectedAccountId: "acct_Synthetic123",
      publicBookingId: BOOKING_ID,
      paymentIntentRef: "pi_Synthetic123",
      amountTotal: 8_000,
      currency: "JPY",
    });
  });

  it("accepts an asynchronous success event only when its session is paid", () => {
    const event = syntheticEvent({
      type: "checkout.session.async_payment_succeeded",
      paymentIntent: { id: "pi_Synthetic123" },
    });
    assert.equal(verifyDirectCheckoutWebhook(signedPayload(event))?.eventType, "checkout.session.async_payment_succeeded");
    assert.throws(
      () => verifyDirectCheckoutWebhook(signedPayload(syntheticEvent({ type: "checkout.session.async_payment_succeeded", paymentStatus: "unpaid" }))),
      /not paid/,
    );
  });

  it("rejects a bad signature and missing connected account, and ignores unrelated events", () => {
    const valid = signedPayload(syntheticEvent());
    assert.throws(
      () => verifyDirectCheckoutWebhook({ ...valid, rawBody: Buffer.from("{}") }),
      /signature verification failed/,
    );
    assert.equal(verifyDirectCheckoutWebhook(signedPayload(syntheticEvent({ type: "charge.succeeded" }))), null);
    assert.equal(verifyDirectCheckoutWebhook(signedPayload(syntheticEvent({ metadata: { booking_id: BOOKING_ID } }))), null);
    assert.throws(
      () => verifyDirectCheckoutWebhook(signedPayload(syntheticEvent({ account: "" }))),
      /connected account ID is required/,
    );
  });

  it("rejects malformed metadata, booking IDs, and amounts", () => {
    assert.equal(verifyDirectCheckoutWebhook(signedPayload(syntheticEvent({ metadata: null }))), null);
    assert.throws(
      () => verifyDirectCheckoutWebhook(signedPayload(syntheticEvent({ metadata: { source: "niho-experience", booking_id: "not-a-booking-id" } }))),
      /UUID v4/,
    );
    assert.throws(
      () => verifyDirectCheckoutWebhook(signedPayload(syntheticEvent({ metadata: { source: "niho-experience", booking_id: BOOKING_ID, guest_email: "guest@example.test" } }))),
      /metadata is malformed/,
    );
    assert.throws(
      () => verifyDirectCheckoutWebhook(signedPayload(syntheticEvent({ amountTotal: 0 }))),
      /positive safe integer/,
    );
  });
});
