import { createHmac } from "node:crypto";
import type { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The experience Stripe webhook (#285): the real experience-payments verifies a synthetic, correctly signed
 * Connect event; the store is stubbed. A paid Session confirms, an unpaid ending releases the hold (slice 4), and a
 * refund this service made moves its booking's refund forward (slice 7).
 */
const state = vi.hoisted(() => ({
  pool: null as null | { query: ReturnType<typeof vi.fn> },
  confirm: null as null | ReturnType<typeof vi.fn>,
  release: null as null | ReturnType<typeof vi.fn>,
  refund: null as null | ReturnType<typeof vi.fn>,
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/experience/store-server", () => ({
  experiencePool: () => state.pool,
  experienceStore: () => (state.confirm ? { confirmBookingPayment: state.confirm } : null),
  guestHoldReleases: () => (state.release ? { releaseGuestHold: state.release } : null),
  bookingCancellations: () => (state.refund ? { applyRefundEvent: state.refund } : null),
}));

import { POST } from "./route";

const SECRET = "whsec_synthetic_endpoint_secret_only";
const BOOKING_ID = "123e4567-e89b-42d3-a456-426614174285";
const CREATED = 1_793_494_200;

function event(type: string, session: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "evt_Synthetic285", object: "event", api_version: "2025-12-15.clover", created: CREATED, livemode: false,
    pending_webhooks: 1, request: null, type, account: "acct_SampleA0001",
    data: {
      object: {
        id: "cs_test_synthetic285", object: "checkout.session", mode: "payment", status: "expired", payment_status: "unpaid",
        metadata: { source: "niho-experience", booking_id: BOOKING_ID }, amount_total: 8000, currency: "jpy", payment_intent: null,
        ...session,
      },
    },
  };
}

/** Stripe's signature scheme (v1 = HMAC-SHA256 of `${t}.${payload}`), so the real verifier accepts the body. */
function delivery(body: Record<string, unknown>, secret = SECRET): NextRequest {
  const payload = JSON.stringify(body);
  const timestamp = Math.floor(Date.now() / 1_000);
  const signature = createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
  return new Request("https://experience.example/api/experience/stripe/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": `t=${timestamp},v1=${signature}` },
    body: payload,
  }) as unknown as NextRequest;
}

let errors: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.stubEnv("EXPERIENCE_STRIPE_WEBHOOK_SECRET", SECRET);
  vi.stubEnv("EXPERIENCE_STRIPE_PLATFORM_SECRET_KEY", "sk_test_synthetic_platform_key_only");
  state.pool = { query: vi.fn().mockResolvedValue({ rows: [{ provider_id: "provider-sample" }] }) };
  state.confirm = vi.fn().mockResolvedValue({ duplicateEvent: false });
  state.release = vi.fn().mockResolvedValue({ status: "EXPIRED", released: true, duplicateEvent: false });
  state.refund = vi.fn().mockResolvedValue({ status: "SUCCEEDED", duplicateEvent: false });
  errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  errors.mockRestore();
});

describe("experience Stripe webhook", () => {
  it("confirms a paid Session in its provider's scope, as before", async () => {
    const paid = event("checkout.session.completed", { status: "complete", payment_status: "paid", payment_intent: "pi_Synthetic285" });
    const response = await POST(delivery(paid));
    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(state.pool!.query).toHaveBeenCalledWith("SELECT provider_id FROM bookings WHERE public_booking_id=$1::uuid", [BOOKING_ID]);
    expect(state.confirm).toHaveBeenCalledWith({ providerId: "provider-sample" }, {
      publicBookingId: BOOKING_ID, connectedAccountId: "acct_SampleA0001", stripePaymentRef: "pi_Synthetic285",
      stripeEventId: "evt_Synthetic285", stripeEventType: "checkout.session.completed", eventOccurredAtUtc: "2026-11-01T00:50:00.000Z",
      amount: 8000, currency: "JPY",
    });
    expect(state.release).not.toHaveBeenCalled();
  });

  it.each(["checkout.session.expired", "checkout.session.async_payment_failed"])("releases the guest's hold when %s", async (type) => {
    const response = await POST(delivery(event(type, type === "checkout.session.expired" ? {} : { status: "complete" })));
    expect(response.status).toBe(204);
    expect(state.release).toHaveBeenCalledWith({
      publicBookingId: BOOKING_ID, checkoutSessionRef: "cs_test_synthetic285", connectedAccountId: "acct_SampleA0001",
      stripeEventId: "evt_Synthetic285", stripeEventType: type, eventOccurredAtUtc: "2026-11-01T00:50:00.000Z",
    });
    expect(state.confirm).not.toHaveBeenCalled();
    expect(state.pool!.query).not.toHaveBeenCalled();
  });

  it("acknowledges another service's Session and unrelated events without touching the store", async () => {
    for (const body of [
      event("checkout.session.expired", { metadata: { booking_id: BOOKING_ID } }),
      event("checkout.session.async_payment_failed", { metadata: {} }),
      event("charge.refunded"),
    ]) {
      expect((await POST(delivery(body))).status).toBe(204);
    }
    expect(state.release).not.toHaveBeenCalled();
    expect(state.confirm).not.toHaveBeenCalled();
  });

  it("refuses a bad signature or a malformed event, and answers 503 without its configuration", async () => {
    expect((await POST(delivery(event("checkout.session.expired"), "whsec_other_secret"))).status).toBe(400);
    expect((await POST(delivery(event("checkout.session.expired", { payment_status: "paid" })))).status).toBe(400);
    expect((await POST(delivery(event("checkout.session.expired", { id: "pi_not_a_session" })))).status).toBe(400);
    expect(state.release).not.toHaveBeenCalled();
    state.release = null;
    expect((await POST(delivery(event("checkout.session.expired")))).status).toBe(503);
  });

  const REFUND_ID = "6f1c2b9e-3a4d-4c5e-8f70-112233445566";
  function refundDelivery(type: string, refund: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      ...event(type),
      data: {
        object: {
          id: "re_test_Synthetic285", object: "refund", amount: 8000, currency: "jpy", payment_intent: "pi_Synthetic285", status: "succeeded",
          failure_reason: null, metadata: { source: "niho-experience", booking_id: BOOKING_ID, refund_id: REFUND_ID }, ...refund,
        },
      },
    };
  }

  it.each(["refund.created", "refund.updated", "refund.failed"])("moves this service's refund forward on %s (#285 slice 7)", async (type) => {
    const response = await POST(delivery(refundDelivery(type, type === "refund.failed" ? { status: "failed", failure_reason: "lost_or_stolen_card" } : {})));
    expect(response.status).toBe(204);
    expect(state.refund).toHaveBeenCalledWith({
      publicBookingId: BOOKING_ID, refundId: REFUND_ID, stripeRefundRef: "re_test_Synthetic285", connectedAccountId: "acct_SampleA0001",
      stripePaymentRef: "pi_Synthetic285", amount: 8000, currency: "JPY",
      status: type === "refund.failed" ? "failed" : "succeeded", failureCode: type === "refund.failed" ? "lost_or_stolen_card" : null,
      stripeEventId: "evt_Synthetic285", stripeEventType: type, eventOccurredAtUtc: "2026-11-01T00:50:00.000Z",
    });
    expect(state.confirm).not.toHaveBeenCalled();
    expect(state.release).not.toHaveBeenCalled();
  });

  it("acknowledges a refund made elsewhere, refuses a malformed one, and asks Stripe to retry when it cannot be recorded", async () => {
    expect((await POST(delivery(refundDelivery("refund.updated", { metadata: {} })))).status).toBe(204);
    expect(state.refund).not.toHaveBeenCalled();
    expect((await POST(delivery(refundDelivery("refund.updated", { metadata: { source: "niho-experience", booking_id: BOOKING_ID } })))).status).toBe(400);
    state.refund!.mockRejectedValue(new Error(`no refund ${REFUND_ID}`));
    expect((await POST(delivery(refundDelivery("refund.updated")))).status).toBe(503);
    expect(JSON.stringify(errors.mock.calls)).not.toMatch(/6f1c2b9e|re_test|acct_|evt_/);
  });

  it("asks Stripe to retry when the release cannot be recorded, without logging the event", async () => {
    state.release!.mockRejectedValue(new Error(`connection lost for ${BOOKING_ID}`));
    const response = await POST(delivery(event("checkout.session.expired")));
    expect(response.status).toBe(503);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(errors.mock.calls)).not.toMatch(/123e4567|cs_test|acct_|evt_|connection lost/);
  });
});
