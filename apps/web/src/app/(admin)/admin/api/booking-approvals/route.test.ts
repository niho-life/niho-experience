import { beforeEach, describe, expect, it, vi } from "vitest";
import { StoreConflictError } from "@niho-experience/experience-store";

const state = vi.hoisted(() => ({
  config: { guestBookingEnabled: true, managedSalesEnabled: true, managedSalesWebhooksEnabled: true, siteUrl: "https://experience.example" },
  http: true,
  mutation: true,
  load: vi.fn(),
  approvals: { listPending: vi.fn(), approve: vi.fn(), decline: vi.fn() },
  bookings: { attachCheckoutSession: vi.fn() },
  account: vi.fn(),
  create: vi.fn(),
  retrieve: vi.fn(),
  expire: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ get config() { return state.config; } }));
vi.mock("@/lib/admin/server", async () => {
  const { NextResponse } = await import("next/server");
  return {
    isAdminHttp: () => state.http,
    adminMutationAllowed: () => state.mutation,
    loadAdminHttpSession: state.load,
    adminJson: (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "cache-control": "private, no-store" } }),
  };
});
vi.mock("@/lib/experience/store-server", () => ({
  managedBookingApprovalRepository: () => state.approvals,
  guestBookingRepository: () => state.bookings,
}));
vi.mock("@niho-experience/experience-payments", () => ({
  retrievePlatformAccount: state.account,
  createPlatformCheckout: state.create,
  retrievePlatformCheckout: state.retrieve,
  expirePlatformCheckout: state.expire,
}));

import { GET, POST } from "./route";

const URL = "https://experience.example/admin/api/booking-approvals";
const BOOKING = "0f8fad5b-d9cb-469f-a165-708677289501";
const ACCOUNT = "acct_PlatformSynthetic1";
const booking = {
  publicBookingId: BOOKING, providerId: "provider-synthetic", productId: "product-synthetic", occurrenceId: "occurrence-synthetic",
  status: "HOLD", seats: 1, idempotencyKey: "request-synthetic", holdExpiresAtUtc: "2026-11-13T00:00:00.000Z",
  occurrenceSnapshot: { occurrenceId: "occurrence-synthetic", ruleId: "rule-synthetic", sourceLocalDate: "2026-11-13", localDate: "2026-11-13", localStartTime: "10:00", timeZone: "Asia/Tokyo", startUtc: "2026-11-13T01:00:00.000Z", endUtc: "2026-11-13T02:00:00.000Z", capacityAtAcceptance: 4, seats: 1, acceptedAtUtc: "2026-11-12T00:00:00.000Z" },
  pricingSnapshot: { currency: "JPY", unitAmount: 10_000, seats: 1, totalAmount: 10_000, cancellationTermsRef: "terms-v1" },
  sellerSnapshot: { experienceProviderId: "provider-synthetic", nihoAccountRef: "niho-synthetic", stripeConnectAccountRef: ACCOUNT, displayName: "NIHO", chargeMode: "PLATFORM", salesPlan: "MANAGED_20", salesPlanRevision: 1, acceptanceMode: "APPROVAL" },
  createdAtUtc: "2026-11-12T00:00:00.000Z",
} as const;

const post = (body: unknown) => new Request(URL, {
  method: "POST", headers: { "content-type": "application/json", origin: URL, "sec-fetch-site": "same-origin" }, body: JSON.stringify(body),
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("EXPERIENCE_STRIPE_PLATFORM_SECRET_KEY", "sk_test_synthetic");
  vi.stubEnv("EXPERIENCE_MANAGED_PLATFORM_ACCOUNT_ID", ACCOUNT);
  state.config = { guestBookingEnabled: true, managedSalesEnabled: true, managedSalesWebhooksEnabled: true, siteUrl: "https://experience.example" };
  state.http = true; state.mutation = true;
  state.load.mockResolvedValue({ status: "ok", actor: { id: "admin-current" } });
  state.approvals.listPending.mockResolvedValue([]);
  state.approvals.approve.mockResolvedValue({ booking, guestEmail: "guest@example.test", checkoutSessionRef: null });
  state.approvals.decline.mockResolvedValue(undefined);
  state.bookings.attachCheckoutSession.mockResolvedValue(undefined);
  state.account.mockResolvedValue({ id: ACCOUNT, chargesEnabled: true, detailsSubmitted: true, country: "JP", defaultCurrency: "JPY" });
  state.create.mockResolvedValue({ checkoutSessionId: "cs_test_approval", checkoutUrl: "https://checkout.stripe.test/pay/approval" });
  state.retrieve.mockResolvedValue({ status: "open", checkoutUrl: "https://checkout.stripe.test/pay/approval" });
  state.expire.mockResolvedValue("expired");
});

describe("managed booking approval Admin BFF", () => {
  it("keeps the private list behind the current Admin session and no-store", async () => {
    const response = await GET(new Request(URL));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(state.approvals.listPending).toHaveBeenCalledWith({ nihoUserId: "admin-current" });
    state.load.mockResolvedValueOnce({ status: "signed-out" });
    expect((await GET(new Request(URL))).status).toBe(401);
  });

  it("approves before creating Checkout and returns the URL only to Admin", async () => {
    const response = await POST(post({ action: "APPROVE", publicBookingId: BOOKING }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ decision: "APPROVED", paymentUrl: "https://checkout.stripe.test/pay/approval" });
    expect(state.approvals.approve).toHaveBeenCalledWith({ nihoUserId: "admin-current" }, BOOKING);
    expect(state.create).toHaveBeenCalledWith(expect.objectContaining({
      booking, returnOrigin: "https://experience.example", returnPath: "/booking/return?type=instant",
      cancelPath: "/booking/return?type=approval", customerEmail: "guest@example.test",
    }));
    expect(state.bookings.attachCheckoutSession).toHaveBeenCalledWith(BOOKING, "cs_test_approval");
  });

  it("retrieves the same attached Session on approval retry and never creates another", async () => {
    state.approvals.approve.mockResolvedValueOnce({ booking, guestEmail: "guest@example.test", checkoutSessionRef: "cs_test_approval" });
    const response = await POST(post({ action: "APPROVE", publicBookingId: BOOKING }));
    expect(await response.json()).toEqual({ decision: "APPROVED", paymentUrl: "https://checkout.stripe.test/pay/approval" });
    expect(state.retrieve).toHaveBeenCalledWith(expect.objectContaining({ checkoutSessionId: "cs_test_approval" }));
    expect(state.create).not.toHaveBeenCalled();
    expect(state.bookings.attachCheckoutSession).not.toHaveBeenCalled();
  });

  it("declines without Stripe and maps a decision collision", async () => {
    expect((await POST(post({ action: "DECLINE", publicBookingId: BOOKING }))).status).toBe(200);
    expect(state.approvals.decline).toHaveBeenCalledWith({ nihoUserId: "admin-current" }, BOOKING);
    expect(state.account).not.toHaveBeenCalled(); expect(state.create).not.toHaveBeenCalled();
    state.approvals.decline.mockRejectedValueOnce(new StoreConflictError("approved"));
    expect((await POST(post({ action: "DECLINE", publicBookingId: BOOKING }))).status).toBe(409);
  });

  it("does not expose a Session when attachment fails", async () => {
    state.bookings.attachCheckoutSession.mockRejectedValueOnce(new StoreConflictError("expired"));
    const response = await POST(post({ action: "APPROVE", publicBookingId: BOOKING }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "conflict" });
    expect(state.expire).toHaveBeenCalled();
  });

  it("keeps the reusable Session when another Admin attached the same idempotent result", async () => {
    state.approvals.approve
      .mockResolvedValueOnce({ booking, guestEmail: "guest@example.test", checkoutSessionRef: null })
      .mockResolvedValueOnce({ booking, guestEmail: "guest@example.test", checkoutSessionRef: "cs_test_approval" });
    state.bookings.attachCheckoutSession.mockRejectedValueOnce(new StoreConflictError("already attached"));
    const response = await POST(post({ action: "APPROVE", publicBookingId: BOOKING }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ decision: "APPROVED", paymentUrl: "https://checkout.stripe.test/pay/approval" });
    expect(state.expire).not.toHaveBeenCalled();
  });
});
