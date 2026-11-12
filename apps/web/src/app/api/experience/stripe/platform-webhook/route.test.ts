import { createHmac } from "node:crypto";
import type { NextRequest } from "next/server";
import { StoreNotFoundError } from "@niho-experience/experience-store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  query: vi.fn(), confirm: vi.fn(), release: vi.fn(), refund: vi.fn(), dispute: vi.fn(), isManagedPayment: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@niho-experience/experience-payments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@niho-experience/experience-payments")>()),
  isManagedPlatformPaymentIntent: state.isManagedPayment,
}));
vi.mock("@/lib/experience/store-server", () => ({
  experiencePool: () => ({ query: state.query }),
  experienceStore: () => ({ confirmBookingPayment: state.confirm }),
  guestHoldReleases: () => ({ releaseGuestHold: state.release }),
  bookingCancellations: () => ({ applyRefundEvent: state.refund }),
  managedExperienceSalesRepository: () => ({ recordDispute: state.dispute }),
}));

import { POST } from "./route";

const SECRET = "whsec_platform_route_synthetic";
const PLATFORM = "acct_PlatformSynthetic1";
const BOOKING = "123e4567-e89b-42d3-a456-426614174509";

function checkout(paymentStatus = "paid", account?: string, type = "checkout.session.completed") {
  return {
    id: "evt_PlatformRouteSynthetic1", object: "event", api_version: "2025-12-15.clover",
    created: 1_793_494_200, livemode: false, pending_webhooks: 1, request: null, type,
    ...(account ? { account } : {}),
    data: { object: { id: "cs_test_platform_route", object: "checkout.session", mode: "payment", status: "complete",
      payment_status: paymentStatus, amount_total: 10_000, currency: "jpy", payment_intent: "pi_PlatformRoute1",
      metadata: { source: "niho-experience-platform", booking_id: BOOKING } } },
  };
}

function delivery(body: Record<string, unknown>): NextRequest {
  const payload = JSON.stringify(body); const timestamp = Math.floor(Date.now() / 1_000);
  const signature = createHmac("sha256", SECRET).update(`${timestamp}.${payload}`).digest("hex");
  return new Request("https://experience.example/api/experience/stripe/platform-webhook", {
    method: "POST", headers: { "content-type": "application/json", "stripe-signature": `t=${timestamp},v1=${signature}` }, body: payload,
  }) as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("EXPERIENCE_STRIPE_PLATFORM_WEBHOOK_SECRET", SECRET);
  vi.stubEnv("EXPERIENCE_STRIPE_PLATFORM_SECRET_KEY", "sk_test_platform_route_synthetic");
  vi.stubEnv("EXPERIENCE_MANAGED_PLATFORM_ACCOUNT_ID", PLATFORM);
  state.query.mockResolvedValue({ rows: [{ provider_id: "provider-synthetic", seller_snapshot: { chargeMode: "PLATFORM", stripeConnectAccountRef: PLATFORM } }] });
  state.confirm.mockResolvedValue({ duplicateEvent: false }); state.release.mockResolvedValue({ released: true });
});
afterEach(() => vi.unstubAllEnvs());

describe("managed platform Stripe webhook route", () => {
  it("confirms a paid account-level Session against its immutable platform snapshot", async () => {
    expect((await POST(delivery(checkout()))).status).toBe(204);
    expect(state.confirm).toHaveBeenCalledWith({ providerId: "provider-synthetic" }, expect.objectContaining({
      publicBookingId: BOOKING, connectedAccountId: PLATFORM, stripePaymentRef: "pi_PlatformRoute1", amount: 10_000, currency: "JPY",
    }));
  });

  it("acknowledges unpaid completed without confirmation and rejects connected-account mixing", async () => {
    expect((await POST(delivery(checkout("unpaid")))).status).toBe(204);
    expect(state.confirm).not.toHaveBeenCalled();
    expect((await POST(delivery(checkout("paid", "acct_ConnectedSynthetic1")))).status).toBe(400);
  });

  it("releases an unpaid expired Session through the original platform snapshot", async () => {
    const event = checkout("unpaid", undefined, "checkout.session.expired");
    expect((await POST(delivery(event))).status).toBe(204);
    expect(state.release).toHaveBeenCalledWith(expect.objectContaining({
      publicBookingId: BOOKING, checkoutSessionRef: "cs_test_platform_route", connectedAccountId: PLATFORM,
    }));
  });

  it("ignores an expired platform Session mapped to a connected-account booking", async () => {
    state.query.mockResolvedValue({ rows: [{ provider_id: "provider-synthetic", seller_snapshot: { chargeMode: "CONNECT_DIRECT", stripeConnectAccountRef: "acct_ConnectedSynthetic1" } }] });
    expect((await POST(delivery(checkout("unpaid", undefined, "checkout.session.expired")))).status).toBe(204);
    expect(state.release).not.toHaveBeenCalled();
  });

  it("acknowledges subscription Checkout from another service without touching bookings", async () => {
    const event = checkout();
    const other = { ...event, data: { object: { ...event.data.object, mode: "subscription", metadata: null } } };
    expect((await POST(delivery(other))).status).toBe(204);
    expect(state.query).not.toHaveBeenCalled();
    expect(state.confirm).not.toHaveBeenCalled();
  });

  it("ignores unrelated disputes and retries managed disputes received before confirmation", async () => {
    const event = {
      ...checkout(),
      type: "charge.dispute.created",
      data: { object: {
        id: "dp_SharedRouteSynthetic", object: "dispute", amount: 10_000,
        currency: "jpy", status: "needs_response", payment_intent: "pi_SharedRouteSynthetic",
      } },
    };
    state.dispute.mockRejectedValueOnce(new StoreNotFoundError("platform booking"))
      .mockRejectedValueOnce(new StoreNotFoundError("platform booking"));
    state.isManagedPayment.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    expect((await POST(delivery(event))).status).toBe(204);
    expect((await POST(delivery(event))).status).toBe(503);
    expect(state.isManagedPayment).toHaveBeenCalledWith({
      paymentIntentId: "pi_SharedRouteSynthetic", platformStripeKey: "sk_test_platform_route_synthetic",
    });
  });
});
