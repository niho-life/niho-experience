import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Stripe from "stripe";
import type { BookingRecord, RefundSubmission } from "@niho-experience/experience-store";
import {
  createDirectCheckout,
  ExperiencePaymentsHoldTooShortError,
  ExperiencePaymentsValidationError,
  isEndedCheckoutEvent,
  isRefundEvent,
  retrieveConnectedAccount,
  retrieveDirectCheckout,
  submitBookingRefund,
  verifyDirectCheckoutWebhook,
  type ConnectedAccountStripeClient,
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
        platformFee: { supportEnabled: false, basisPoints: 1000, amount: 1_000 },
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

  it("charges a guest booking the fee of its snapshot, with a cancel URL and the guest's email (#285)", async () => {
    let receivedParams: Stripe.Checkout.SessionCreateParams | undefined;
    let receivedOptions: Stripe.RequestOptions | undefined;
    const stripe = {
      checkout: { sessions: { create: async (params: Stripe.Checkout.SessionCreateParams, options?: Stripe.RequestOptions) => {
        receivedParams = params;
        receivedOptions = options;
        return { id: "cs_test_synthetic", url: "https://checkout.stripe.com/c/pay/synthetic" };
      } } },
    } as unknown as PaymentsStripeClient;
    const base = booking();
    const guest = booking({
      pricingSnapshot: {
        ...base.pricingSnapshot,
        breakdown: { adultCount: 2, childCount: 0, childUnitAmount: null }, cancellationPolicy: "NONE",
        platformFee: { supportEnabled: true, basisPoints: 1500, amount: 1_200 },
      },
    });
    const input = {
      booking: guest,
      returnOrigin: "https://experience.example.test",
      returnPath: "/booking/return?type=instant",
      cancelPath: "/experiences/sample-tea?checkout=cancelled",
      customerEmail: "guest@example.com",
      stripe,
      now: NOW,
    };
    await createDirectCheckout(input);
    assert.deepEqual(receivedParams?.payment_intent_data, { application_fee_amount: 1_200 });
    assert.equal(receivedParams?.success_url, "https://experience.example.test/booking/return?type=instant");
    assert.equal(receivedParams?.cancel_url, "https://experience.example.test/experiences/sample-tea?checkout=cancelled");
    assert.equal(receivedParams?.customer_email, "guest@example.com");
    assert.equal(receivedOptions?.idempotencyKey, `experience-checkout:${BOOKING_ID}`);
    // The guest's address goes to Stripe's own field only, never to metadata.
    assert.deepEqual(receivedParams?.metadata, { source: "niho-experience", booking_id: BOOKING_ID });

    // The same fee may be passed explicitly; another one is refused.
    await createDirectCheckout({ ...input, applicationFeeAmount: 1_200 });
    await assert.rejects(createDirectCheckout({ ...input, applicationFeeAmount: 800 }), /must equal the booking's platform fee snapshot/);
    // A guest booking without its fee snapshot is refused, even with a fee.
    const withoutFee = { ...guest, pricingSnapshot: { ...guest.pricingSnapshot, platformFee: undefined } };
    await assert.rejects(createDirectCheckout({ ...input, booking: withoutFee, applicationFeeAmount: 1_200 }), /must carry its platform fee snapshot/);
    // A snapshot fee Stripe would refuse is refused here first.
    for (const amount of [0, 8_000, 1.5]) {
      const bad = { ...guest, pricingSnapshot: { ...guest.pricingSnapshot, platformFee: { supportEnabled: true, basisPoints: 1500 as const, amount } } };
      await assert.rejects(createDirectCheckout({ ...input, booking: bad }), ExperiencePaymentsValidationError);
    }
    // A booking without a fee snapshot still needs a trusted fee.
    await assert.rejects(createDirectCheckout({ ...input, booking: booking() }), /applicationFeeAmount is required/);

    // Without the optional fields Stripe gets neither.
    await createDirectCheckout({ ...input, cancelPath: undefined, customerEmail: undefined });
    assert.equal("cancel_url" in (receivedParams ?? {}), false);
    assert.equal("customer_email" in (receivedParams ?? {}), false);
  });

  it("keeps the cancel URL on the trusted origin and never repeats a refused email address", async () => {
    const base = {
      booking: booking(),
      applicationFeeAmount: 800,
      returnOrigin: "https://experience.example.test",
      returnPath: "/booking/return",
      stripe: {} as PaymentsStripeClient,
      now: NOW,
    };
    for (const cancelPath of ["//attacker.example/x", "https://attacker.example/x", "experiences/sample", "/\\attacker.example", "/experiences/sample#top"]) {
      await assert.rejects(createDirectCheckout({ ...base, cancelPath }), /cancelPath must/, cancelPath);
    }
    for (const customerEmail of ["not-an-address", "secret@example", "two words@example.com", "secret@example.com\n", "x".repeat(250) + "@example.com"]) {
      const error = await createDirectCheckout({ ...base, customerEmail }).then(() => null, (caught: unknown) => caught);
      assert.ok(error instanceof ExperiencePaymentsValidationError);
      assert.doesNotMatch(error.message, /secret|example|words/);
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
      ExperiencePaymentsHoldTooShortError,
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
  sessionId?: string;
  status?: string;
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
        id: options.sessionId ?? "cs_test_synthetic",
        object: "checkout.session",
        mode: "payment",
        status: options.status ?? "complete",
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

describe("retrieveDirectCheckout", () => {
  function stripeWith(session: Record<string, unknown>, calls: unknown[][] = []): PaymentsStripeClient {
    return {
      checkout: { sessions: { retrieve: async (...args: unknown[]) => { calls.push(args); return session; } } },
    } as unknown as PaymentsStripeClient;
  }
  const mine = { id: "cs_test_synthetic", metadata: { source: "niho-experience", booking_id: BOOKING_ID } };

  it("reads the booking's Session on the seller's account: open with its URL, paid, or over", async () => {
    const calls: unknown[][] = [];
    const open = await retrieveDirectCheckout({
      booking: booking(), checkoutSessionId: "cs_test_synthetic",
      stripe: stripeWith({ ...mine, status: "open", url: "https://checkout.stripe.com/c/pay/synthetic" }, calls),
    });
    assert.deepEqual(open, { status: "open", checkoutUrl: "https://checkout.stripe.com/c/pay/synthetic" });
    assert.deepEqual(calls, [["cs_test_synthetic", undefined, { stripeAccount: booking().sellerSnapshot.stripeConnectAccountRef }]]);
    assert.deepEqual(await retrieveDirectCheckout({ booking: booking(), checkoutSessionId: "cs_test_synthetic", stripe: stripeWith({ ...mine, status: "complete", url: null }) }), { status: "complete" });
    assert.deepEqual(await retrieveDirectCheckout({ booking: booking(), checkoutSessionId: "cs_test_synthetic", stripe: stripeWith({ ...mine, status: "expired", url: null }) }), { status: "expired" });
  });

  it("refuses a malformed id and a Session of another booking", async () => {
    await assert.rejects(() => retrieveDirectCheckout({ booking: booking(), checkoutSessionId: "pi_synthetic", stripe: stripeWith(mine) }), ExperiencePaymentsValidationError);
    const other = { ...mine, status: "open", url: "https://checkout.stripe.com/c/pay/other", metadata: { booking_id: "00000000-0000-4000-8000-000000000000" } };
    await assert.rejects(() => retrieveDirectCheckout({ booking: booking(), checkoutSessionId: "cs_test_synthetic", stripe: stripeWith(other) }), ExperiencePaymentsValidationError);
  });
});

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

  it("returns the Session of an unpaid expiry or failed delayed payment, without payment fields (#285 slice 4)", () => {
    const expired = syntheticEvent({
      type: "checkout.session.expired", status: "expired", paymentStatus: "unpaid", amountTotal: null, currency: null, paymentIntent: null,
    });
    assert.deepEqual(verifyDirectCheckoutWebhook(signedPayload(expired)), {
      eventId: "evt_Synthetic123",
      eventType: "checkout.session.expired",
      eventOccurredAtUtc: "2026-11-01T00:50:00.000Z",
      connectedAccountId: "acct_Synthetic123",
      publicBookingId: BOOKING_ID,
      checkoutSessionId: "cs_test_synthetic",
    });
    const failed = syntheticEvent({ type: "checkout.session.async_payment_failed", paymentStatus: "unpaid", metadata: { source: "niho-experience", booking_id: BOOKING_ID.toUpperCase() } });
    const verified = verifyDirectCheckoutWebhook(signedPayload(failed));
    assert.ok(verified !== null && isEndedCheckoutEvent(verified));
    assert.equal(isEndedCheckoutEvent(verifyDirectCheckoutWebhook(signedPayload(syntheticEvent()))!), false);
    assert.deepEqual(verified, {
      eventId: "evt_Synthetic123",
      eventType: "checkout.session.async_payment_failed",
      eventOccurredAtUtc: "2026-11-01T00:50:00.000Z",
      connectedAccountId: "acct_Synthetic123",
      publicBookingId: BOOKING_ID,
      checkoutSessionId: "cs_test_synthetic",
    });
  });

  it("checks an ended Session as strictly as a paid one, and never ends a paid Session", () => {
    const ended = (options: SyntheticEventOptions) => signedPayload(syntheticEvent({ type: "checkout.session.expired", status: "expired", paymentStatus: "unpaid", ...options }));
    // Another service's Session on the shared platform is acknowledged and ignored.
    assert.equal(verifyDirectCheckoutWebhook(ended({ metadata: { booking_id: BOOKING_ID } })), null);
    assert.equal(verifyDirectCheckoutWebhook(ended({ metadata: null })), null);
    assert.throws(() => verifyDirectCheckoutWebhook(ended({ account: "" })), /connected account ID is required/);
    assert.throws(() => verifyDirectCheckoutWebhook(ended({ metadata: { source: "niho-experience", booking_id: "not-a-booking-id" } })), /UUID v4/);
    assert.throws(
      () => verifyDirectCheckoutWebhook(ended({ metadata: { source: "niho-experience", booking_id: BOOKING_ID, guest_email: "guest@example.test" } })),
      /metadata is malformed/,
    );
    assert.throws(() => verifyDirectCheckoutWebhook(ended({ sessionId: "pi_Synthetic123" })), /Session ID is malformed/);
    assert.throws(() => verifyDirectCheckoutWebhook(ended({ paymentStatus: "paid" })), /ended Checkout Session is paid/);
    assert.throws(
      () => verifyDirectCheckoutWebhook(signedPayload(syntheticEvent({ type: "checkout.session.async_payment_failed", paymentStatus: "paid" }))),
      /ended Checkout Session is paid/,
    );
    const valid = ended({});
    assert.throws(() => verifyDirectCheckoutWebhook({ ...valid, rawBody: Buffer.from("{}") }), /signature verification failed/);
  });
});

describe("submitBookingRefund (#285 slice 7)", () => {
  const REFUND_ID = "6f1c2b9e-3a4d-4c5e-8f70-112233445566";
  const fullRefund: RefundSubmission = {
    refundId: REFUND_ID, publicBookingId: BOOKING_ID, connectedAccountId: "acct_Synthetic123", stripePaymentRef: "pi_Synthetic123",
    kind: "FULL", amount: 8_000, currency: "JPY", refundApplicationFee: true,
  };
  function stripeWith(options: { listed?: unknown[]; created?: Record<string, unknown>; createError?: unknown }, calls: { list: unknown[][]; create: unknown[][] }) {
    return {
      refunds: {
        list: async (...args: unknown[]) => { calls.list.push(args); return { data: options.listed ?? [] }; },
        create: async (...args: unknown[]) => {
          calls.create.push(args);
          if (options.createError) throw options.createError;
          return options.created ?? { id: "re_test_Synthetic1", amount: 8_000, status: "pending", failure_reason: null, metadata: {} };
        },
      },
    } as unknown as PaymentsStripeClient;
  }

  it("refunds on the seller's account with our refund ID as the idempotency key, giving NIHO's fee back in full", async () => {
    const calls = { list: [] as unknown[][], create: [] as unknown[][] };
    const answer = await submitBookingRefund({ refund: fullRefund, stripe: stripeWith({}, calls) });
    assert.deepEqual(answer, { kind: "accepted", stripeRefundRef: "re_test_Synthetic1", status: "pending", failureCode: null });
    assert.deepEqual(calls.list[0], [{ payment_intent: "pi_Synthetic123", limit: 100 }, { stripeAccount: "acct_Synthetic123" }]);
    assert.deepEqual(calls.create[0], [
      {
        payment_intent: "pi_Synthetic123", amount: 8_000, refund_application_fee: true,
        metadata: { source: "niho-experience", booking_id: BOOKING_ID, refund_id: REFUND_ID },
      },
      { stripeAccount: "acct_Synthetic123", idempotencyKey: `experience-refund:${REFUND_ID}` },
    ]);
  });

  it("keeps NIHO's fee on a partial refund, and finds a refund made before instead of making another", async () => {
    const calls = { list: [] as unknown[][], create: [] as unknown[][] };
    const partial: RefundSubmission = { ...fullRefund, kind: "PARTIAL", amount: 3_000, refundApplicationFee: false };
    await submitBookingRefund({ refund: partial, stripe: stripeWith({ created: { id: "re_test_Partial1", amount: 3_000, status: "succeeded" } }, calls) });
    assert.equal((calls.create[0]![0] as Record<string, unknown>).refund_application_fee, false);

    const again = { list: [] as unknown[][], create: [] as unknown[][] };
    const listed = [
      { id: "re_test_Other", amount: 8_000, status: "succeeded", metadata: {} },
      { id: "re_test_Mine", amount: 8_000, status: "succeeded", failure_reason: null, metadata: { source: "niho-experience", booking_id: BOOKING_ID, refund_id: REFUND_ID } },
    ];
    const answer = await submitBookingRefund({ refund: fullRefund, stripe: stripeWith({ listed }, again) });
    assert.deepEqual(answer, { kind: "accepted", stripeRefundRef: "re_test_Mine", status: "succeeded", failureCode: null });
    assert.equal(again.create.length, 0);
  });

  it("answers a refusal for good as rejected, and throws for anything that may succeed later", async () => {
    const calls = { list: [] as unknown[][], create: [] as unknown[][] };
    const refused = new Stripe.errors.StripeInvalidRequestError({ message: "Charge has already been refunded.", code: "charge_already_refunded", type: "invalid_request_error" } as never);
    assert.deepEqual(await submitBookingRefund({ refund: fullRefund, stripe: stripeWith({ createError: refused }, calls) }), { kind: "rejected", failureCode: "charge_already_refunded" });
    const offline = new Stripe.errors.StripeConnectionError({ message: "offline", type: "api_error" } as never);
    await assert.rejects(submitBookingRefund({ refund: fullRefund, stripe: stripeWith({ createError: offline }, calls) }), /offline/);
    await assert.rejects(
      submitBookingRefund({ refund: fullRefund, stripe: stripeWith({ created: { id: "re_test_Synthetic1", amount: 7_999, status: "pending" } }, calls) }),
      /another amount/,
    );
  });

  it("refuses a refund whose fee choice, IDs or amount are not what the store hands out", async () => {
    const calls = { list: [] as unknown[][], create: [] as unknown[][] };
    const stripe = stripeWith({}, calls);
    for (const refund of [
      { ...fullRefund, refundApplicationFee: false },
      { ...fullRefund, kind: "PARTIAL" as const },
      { ...fullRefund, refundId: "not-a-uuid" },
      { ...fullRefund, connectedAccountId: "acct_x" },
      { ...fullRefund, stripePaymentRef: "ch_Synthetic123" },
      { ...fullRefund, amount: 0 },
      { ...fullRefund, currency: "jpy" },
    ]) {
      await assert.rejects(submitBookingRefund({ refund, stripe }), ExperiencePaymentsValidationError);
    }
    assert.equal(calls.list.length + calls.create.length, 0);
  });
});

describe("refund webhooks (#285 slice 7)", () => {
  const REFUND_ID = "6f1c2b9e-3a4d-4c5e-8f70-112233445566";
  function refundEventOf(options: { type?: string; metadata?: Record<string, string> | null; status?: string | null; failureReason?: string | null; amount?: unknown; object?: string; account?: string } = {}) {
    return {
      id: "evt_SyntheticRefund1", object: "event", api_version: "2025-12-15.clover", created: 1_793_494_200, livemode: false, pending_webhooks: 1, request: null,
      type: options.type ?? "refund.updated",
      account: options.account ?? "acct_Synthetic123",
      data: {
        object: {
          id: "re_test_Synthetic1", object: options.object ?? "refund", amount: options.amount === undefined ? 8_000 : options.amount, currency: "jpy",
          payment_intent: "pi_Synthetic123", status: options.status === undefined ? "succeeded" : options.status,
          failure_reason: options.failureReason ?? null,
          metadata: options.metadata === undefined ? { source: "niho-experience", booking_id: BOOKING_ID, refund_id: REFUND_ID } : options.metadata,
        },
      },
    };
  }

  it("returns the status of a refund this service made, for its booking and refund", () => {
    const event = verifyDirectCheckoutWebhook(signedPayload(refundEventOf()));
    assert.deepEqual(event, {
      eventId: "evt_SyntheticRefund1", eventType: "refund.updated", eventOccurredAtUtc: "2026-11-01T00:50:00.000Z", connectedAccountId: "acct_Synthetic123",
      publicBookingId: BOOKING_ID, refundId: REFUND_ID, stripeRefundRef: "re_test_Synthetic1", paymentIntentRef: "pi_Synthetic123",
      amount: 8_000, currency: "JPY", status: "succeeded", failureCode: null,
    });
    assert.ok(event && isRefundEvent(event) && !isEndedCheckoutEvent(event));
    const failed = verifyDirectCheckoutWebhook(signedPayload(refundEventOf({ type: "refund.failed", status: "failed", failureReason: "expired_or_canceled_card" })));
    assert.deepEqual([failed && isRefundEvent(failed) && failed.status, failed && isRefundEvent(failed) && failed.failureCode], ["failed", "expired_or_canceled_card"]);
    const created = verifyDirectCheckoutWebhook(signedPayload(refundEventOf({ type: "refund.created", status: null })));
    assert.equal(created && isRefundEvent(created) && created.status, "pending");
  });

  it("ignores refunds made elsewhere and charge.refunded, and refuses malformed ones", () => {
    assert.equal(verifyDirectCheckoutWebhook(signedPayload(refundEventOf({ metadata: {} }))), null);
    assert.equal(verifyDirectCheckoutWebhook(signedPayload(refundEventOf({ metadata: null }))), null);
    assert.equal(verifyDirectCheckoutWebhook(signedPayload(refundEventOf({ type: "charge.refunded", object: "charge" }))), null);
    assert.throws(() => verifyDirectCheckoutWebhook(signedPayload(refundEventOf({ account: "" }))), /connected account ID is required/);
    assert.throws(() => verifyDirectCheckoutWebhook(signedPayload(refundEventOf({ metadata: { source: "niho-experience", booking_id: BOOKING_ID } }))), /metadata is malformed/);
    assert.throws(() => verifyDirectCheckoutWebhook(signedPayload(refundEventOf({ metadata: { source: "niho-experience", booking_id: BOOKING_ID, refund_id: "x" } }))), /IDs are malformed/);
    assert.throws(() => verifyDirectCheckoutWebhook(signedPayload(refundEventOf({ status: "lost" }))), /status is unknown/);
    assert.throws(() => verifyDirectCheckoutWebhook(signedPayload(refundEventOf({ amount: 0 }))), /refund amount/);
    assert.throws(() => verifyDirectCheckoutWebhook(signedPayload(refundEventOf({ object: "charge" }))), /does not contain a Refund/);
  });
});

describe("retrieveConnectedAccount (#285 slice 9)", () => {
  const ACCOUNT = "acct_SampleSeller0001";
  const READY = { id: ACCOUNT, object: "account", country: "JP", default_currency: "jpy", charges_enabled: true, payouts_enabled: true, details_submitted: true, email: "seller@example.com" };
  function stripeWith(answer: { account?: Record<string, unknown>; error?: unknown }, calls: unknown[][] = []) {
    return {
      accounts: {
        retrieve: async (...args: unknown[]) => {
          calls.push(args);
          if (answer.error) throw answer.error;
          return answer.account ?? READY;
        },
      },
    } as unknown as ConnectedAccountStripeClient;
  }
  function stripeError(type: string, code?: string): Error {
    return Object.assign(new Error("synthetic Stripe error naming acct_SampleSeller0001"), { type, code });
  }

  it("reads the account with the platform key and returns only the last 4 of its ID and the checked facts", async () => {
    const calls: unknown[][] = [];
    const answer = await retrieveConnectedAccount({ accountId: ACCOUNT, stripe: stripeWith({}, calls) });
    assert.deepEqual(calls, [[ACCOUNT]]);
    assert.deepEqual(answer, {
      kind: "ready",
      account: { idLast4: "0001", country: "JP", defaultCurrency: "jpy", chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true },
    });
    assert.equal(JSON.stringify(answer).includes("example.com"), false);
  });

  it("lists what keeps the account from taking JPY charges here", async () => {
    const answer = await retrieveConnectedAccount({
      accountId: ACCOUNT,
      stripe: stripeWith({ account: { ...READY, country: "US", default_currency: "usd", charges_enabled: false, payouts_enabled: false, details_submitted: false } }),
    });
    assert.deepEqual(answer, {
      kind: "not_ready",
      account: { idLast4: "0001", country: "US", defaultCurrency: "usd", chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: false },
      problems: ["CHARGES_DISABLED", "PAYOUTS_DISABLED", "DETAILS_NOT_SUBMITTED", "NOT_JAPAN", "NOT_JPY"],
    });
    const missing = await retrieveConnectedAccount({ accountId: ACCOUNT, stripe: stripeWith({ account: { ...READY, country: undefined, default_currency: undefined } }) });
    assert.deepEqual(missing.kind === "not_ready" && missing.problems, ["NOT_JAPAN", "NOT_JPY"]);
  });

  it("answers unreachable when Stripe will not show the account to this platform, and throws on other failures", async () => {
    assert.deepEqual(await retrieveConnectedAccount({ accountId: ACCOUNT, stripe: stripeWith({ error: stripeError("StripePermissionError") }) }), { kind: "unreachable" });
    assert.deepEqual(await retrieveConnectedAccount({ accountId: ACCOUNT, stripe: stripeWith({ error: stripeError("StripeInvalidRequestError", "resource_missing") }) }), { kind: "unreachable" });
    assert.deepEqual(await retrieveConnectedAccount({ accountId: ACCOUNT, stripe: stripeWith({ error: stripeError("StripeInvalidRequestError", "account_invalid") }) }), { kind: "unreachable" });
    await assert.rejects(retrieveConnectedAccount({ accountId: ACCOUNT, stripe: stripeWith({ error: stripeError("StripeInvalidRequestError", "parameter_invalid") }) }), /synthetic Stripe error/);
    await assert.rejects(retrieveConnectedAccount({ accountId: ACCOUNT, stripe: stripeWith({ error: stripeError("StripeConnectionError") }) }), /synthetic Stripe error/);
    await assert.rejects(retrieveConnectedAccount({ accountId: ACCOUNT, stripe: stripeWith({ account: { ...READY, id: "acct_SampleOther0002" } }) }), /another account/);
  });

  it("refuses a malformed account ID before calling Stripe, and needs exactly one of key or client", async () => {
    const calls: unknown[][] = [];
    await assert.rejects(retrieveConnectedAccount({ accountId: "cus_Sample0001", stripe: stripeWith({}, calls) }), ExperiencePaymentsValidationError);
    await assert.rejects(retrieveConnectedAccount({ accountId: `${ACCOUNT}\n`, stripe: stripeWith({}, calls) }), ExperiencePaymentsValidationError);
    assert.deepEqual(calls, []);
    await assert.rejects(retrieveConnectedAccount({ accountId: ACCOUNT }), /platform Stripe key/);
    await assert.rejects(retrieveConnectedAccount({ accountId: ACCOUNT, platformStripeKey: "sk_test_synthetic", stripe: stripeWith({}) }), /either platformStripeKey or stripe/);
  });
});
