import { beforeEach, describe, expect, it, vi } from "vitest";
import { StoreConflictError, StoreValidationError } from "@niho-experience/experience-store";

/** サイト予約の取消・返金 for NIHO support (#285 slice 7): the Admin BFF against a stubbed store and Stripe. Synthetic data. */
const mocks = vi.hoisted(() => ({
  csrf: true,
  config: { guestBookingEnabled: true, siteUrl: "https://experience.example" },
  load: vi.fn(),
  store: {} as Record<string, ReturnType<typeof vi.fn>>,
  messages: { sendSupportMessage: vi.fn() },
  submit: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ get config() { return mocks.config; } }));
vi.mock("@/lib/admin/server", async () => {
  const { NextResponse } = await import("next/server");
  return {
    isAdminHttp: () => true,
    adminMutationAllowed: () => mocks.csrf,
    loadAdminHttpSession: mocks.load,
    adminJson: (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "cache-control": "private, no-store" } }),
  };
});
vi.mock("@/lib/experience/store-server", () => ({ bookingCancellations: () => mocks.store, guestBookingMessages: () => mocks.messages }));
vi.mock("@niho-experience/experience-payments", () => ({ submitBookingRefund: (...args: unknown[]) => mocks.submit(...args) }));

import { GET, POST } from "./route";

const URL = "https://experience.example/admin/api/site-bookings";
const BOOKING = "0f8fad5b-d9cb-469f-a165-708677289501";
const REFUND_ID = "7f1c2b9e-3a4d-4c5e-8f70-112233445566";
const COMMAND = "00000000-0000-4000-8000-000000000221";
const SNAPSHOT = "a".repeat(64);
const ACTOR = { nihoUserId: "admin-a" };
const SUBMISSION = {
  refundId: REFUND_ID, publicBookingId: BOOKING, connectedAccountId: "acct_SampleA0001", stripePaymentRef: "pi_SampleA0001",
  kind: "PARTIAL", amount: 3000, currency: "JPY", refundApplicationFee: true,
};
const cancelled = { outcome: "CANCELLED", repeated: false, bookingIds: [BOOKING], refunds: [SUBMISSION] };
const post = (body: unknown, contentType = "application/json") =>
  new Request(URL, { method: "POST", headers: { origin: "https://experience.example", "sec-fetch-site": "same-origin", "content-type": contentType }, body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.csrf = true;
  mocks.config = { guestBookingEnabled: true, siteUrl: "https://experience.example" };
  mocks.load.mockResolvedValue({ status: "ok", kind: "niho", actor: { id: "admin-a", displayName: null }, verified: { actor: { id: "admin-a" } } });
  mocks.store = {
    supportQueue: vi.fn(async () => ({ cancellationRequests: [], paymentReviews: [], refunds: [] })),
    cancelAsSupport: vi.fn(async () => cancelled),
    resolveCancellationRequest: vi.fn(async () => cancelled),
    resolvePaymentReview: vi.fn(async () => cancelled),
    retryRefund: vi.fn(async () => ({ ...cancelled, outcome: "REFUND_RETRIED" })),
    closeFailedRefund: vi.fn(async () => ({ outcome: "REFUND_CLOSED", repeated: false, bookingIds: [BOOKING], refunds: [] })),
    recordRefundSubmission: vi.fn(async () => "PENDING"),
  };
  mocks.submit.mockResolvedValue({ kind: "accepted", stripeRefundRef: "re_test_Sample1", status: "pending", failureCode: null });
  mocks.messages.sendSupportMessage.mockResolvedValue({ repeated: false });
  vi.stubEnv("EXPERIENCE_STRIPE_PLATFORM_SECRET_KEY", "sk_test_synthetic_platform_key_only");
});

describe("Admin site bookings BFF", () => {
  it("reads support's queue for a verified Admin only, with no query", async () => {
    const response = await GET(new Request(URL));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.store.supportQueue).toHaveBeenCalledWith({ limit: 100 });
    expect((await GET(new Request(`${URL}?providerId=all`))).status).toBe(400);
    mocks.load.mockResolvedValueOnce({ status: "rejected" });
    expect((await GET(new Request(URL))).status).toBe(401);
    mocks.load.mockResolvedValueOnce({ status: "error" });
    expect((await GET(new Request(URL))).status).toBe(503);
    mocks.config = { ...mocks.config, guestBookingEnabled: false };
    expect((await GET(new Request(URL))).status).toBe(404);
    expect((await POST(post({ action: "RESOLVE_PAYMENT_REVIEW", commandId: COMMAND, expectedSnapshot: SNAPSHOT, publicBookingId: BOOKING }))).status).toBe(404);
  });

  it("cancels with a partial refund as the verified Admin, sends it to Stripe and answers where it is", async () => {
    const response = await POST(post({ action: "CANCEL", commandId: COMMAND, expectedSnapshot: SNAPSHOT, publicBookingId: BOOKING, reason: "HOST_UNAVAILABLE", note: "By agreement", refund: { kind: "PARTIAL", amount: 3000 } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: "CANCELLED", repeated: false, bookingIds: [BOOKING], refunds: [{ refundId: REFUND_ID, status: "PENDING" }] });
    expect(mocks.store.cancelAsSupport).toHaveBeenCalledWith(ACTOR, BOOKING, { commandId: COMMAND, expectedSnapshot: SNAPSHOT, reason: "HOST_UNAVAILABLE", note: "By agreement", refund: { kind: "PARTIAL", amount: 3000 } });
    expect(mocks.submit).toHaveBeenCalledWith({ refund: SUBMISSION, platformStripeKey: "sk_test_synthetic_platform_key_only" });
  });

  it("acts as an admin signed in with Google (ADR 0003) by their adm_ actor ID, from the experience DB alone", async () => {
    const admin = `adm_${"0123456789abcdef".repeat(2)}`;
    mocks.load.mockResolvedValue({ status: "ok", kind: "experience", actor: { id: admin, displayName: "admin.sample@niho.life" }, session: { kind: "experience" } });
    const response = await POST(post({ action: "RESOLVE_PAYMENT_REVIEW", commandId: COMMAND, expectedSnapshot: SNAPSHOT, publicBookingId: BOOKING }));
    expect(response.status).toBe(200);
    expect(mocks.store.resolvePaymentReview).toHaveBeenCalledWith({ nihoUserId: admin }, BOOKING, { commandId: COMMAND, expectedSnapshot: SNAPSHOT });
  });

  it("answers requests, resolves late payments and retries or closes refunds", async () => {
    await POST(post({ action: "APPROVE_REQUEST", commandId: COMMAND, expectedSnapshot: SNAPSHOT, publicBookingId: BOOKING, refund: { kind: "FULL" } }));
    expect(mocks.store.resolveCancellationRequest).toHaveBeenLastCalledWith(ACTOR, BOOKING, { commandId: COMMAND, expectedSnapshot: SNAPSHOT, decision: "APPROVE", refund: { kind: "FULL" }, note: null });
    await POST(post({ action: "DECLINE_REQUEST", commandId: COMMAND, expectedSnapshot: SNAPSHOT, publicBookingId: BOOKING, message: "Sample reply." }));
    expect(mocks.store.resolveCancellationRequest).toHaveBeenLastCalledWith(ACTOR, BOOKING, { commandId: COMMAND, expectedSnapshot: SNAPSHOT, decision: "DECLINE", message: "Sample reply." });
    await POST(post({ action: "RESOLVE_PAYMENT_REVIEW", commandId: COMMAND, expectedSnapshot: SNAPSHOT, publicBookingId: BOOKING }));
    expect(mocks.store.resolvePaymentReview).toHaveBeenCalledWith(ACTOR, BOOKING, { commandId: COMMAND, expectedSnapshot: SNAPSHOT });
    await POST(post({ action: "RETRY_REFUND", commandId: COMMAND, expectedSnapshot: SNAPSHOT, refundId: REFUND_ID }));
    expect(mocks.store.retryRefund).toHaveBeenCalledWith(ACTOR, REFUND_ID, { commandId: COMMAND, expectedSnapshot: SNAPSHOT });
    const closed = await POST(post({ action: "CLOSE_REFUND", commandId: COMMAND, expectedSnapshot: SNAPSHOT, refundId: REFUND_ID, note: "Bank transfer" }));
    expect((await closed.json()).outcome).toBe("REFUND_CLOSED");
    expect(mocks.store.closeFailedRefund).toHaveBeenCalledWith(ACTOR, REFUND_ID, { commandId: COMMAND, expectedSnapshot: SNAPSHOT, note: "Bank transfer" });
  });

  it("keeps the refund requested when Stripe cannot be reached, so it shows in the queue to send again", async () => {
    mocks.submit.mockRejectedValueOnce(new Error("offline"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await POST(post({ action: "RESOLVE_PAYMENT_REVIEW", commandId: COMMAND, expectedSnapshot: SNAPSHOT, publicBookingId: BOOKING }));
    expect((await response.json()).refunds).toEqual([{ refundId: REFUND_ID, status: "REQUESTED" }]);
    expect(mocks.store.recordRefundSubmission).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it("refuses other origins, a missing command, unknown actions, and maps the store's refusals", async () => {
    mocks.csrf = false;
    expect((await POST(post({ action: "RESOLVE_PAYMENT_REVIEW", commandId: COMMAND, expectedSnapshot: SNAPSHOT, publicBookingId: BOOKING }))).status).toBe(403);
    mocks.csrf = true;
    expect((await POST(post({ action: "RESOLVE_PAYMENT_REVIEW", publicBookingId: BOOKING }))).status).toBe(400);
    expect((await POST(post({ action: "RESOLVE_PAYMENT_REVIEW", commandId: COMMAND, publicBookingId: BOOKING }))).status).toBe(400);
    expect((await POST(post({ action: "DELETE", commandId: COMMAND, expectedSnapshot: SNAPSHOT }))).status).toBe(400);
    expect((await POST(post({ action: "CANCEL", commandId: COMMAND, expectedSnapshot: SNAPSHOT, publicBookingId: BOOKING, reason: "OTHER" }))).status).toBe(400);
    expect((await POST(post({ action: "RESOLVE_PAYMENT_REVIEW", commandId: COMMAND, expectedSnapshot: SNAPSHOT, publicBookingId: BOOKING }, "text/plain"))).status).toBe(400);
    expect((await POST(post({ action: "RESOLVE_PAYMENT_REVIEW", commandId: COMMAND, expectedSnapshot: SNAPSHOT, publicBookingId: BOOKING, extra: true }))).status).toBe(400);
    mocks.store.resolvePaymentReview!.mockRejectedValueOnce(new StoreConflictError("command"));
    expect((await POST(post({ action: "RESOLVE_PAYMENT_REVIEW", commandId: COMMAND, expectedSnapshot: SNAPSHOT, publicBookingId: BOOKING }))).status).toBe(409);
    mocks.store.cancelAsSupport!.mockRejectedValueOnce(new StoreValidationError("amount"));
    expect((await POST(post({ action: "CANCEL", commandId: COMMAND, expectedSnapshot: SNAPSHOT, publicBookingId: BOOKING, reason: "OTHER", refund: { kind: "PARTIAL", amount: 99999 } }))).status).toBe(400);
    mocks.load.mockResolvedValueOnce({ status: "signed-out" });
    expect((await POST(post({ action: "RESOLVE_PAYMENT_REVIEW", commandId: COMMAND, expectedSnapshot: SNAPSHOT, publicBookingId: BOOKING }))).status).toBe(401);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.store.resolvePaymentReview!.mockRejectedValueOnce(new Error("timeout"));
    expect((await POST(post({ action: "RESOLVE_PAYMENT_REVIEW", commandId: COMMAND, expectedSnapshot: SNAPSHOT, publicBookingId: BOOKING }))).status).toBe(503);
    errors.mockRestore();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("keeps CONTACT_GUEST on the messages path and rejects unknown contact fields", async () => {
    const sent = await POST(post({ action: "CONTACT_GUEST", commandId: COMMAND, publicBookingId: BOOKING, message: "Synthetic message" }));
    expect(sent.status).toBe(200);
    expect(await sent.json()).toEqual({ outcome: "CONTACT_SENT", repeated: false });
    expect(mocks.messages.sendSupportMessage).toHaveBeenCalledWith(ACTOR, BOOKING, { commandId: COMMAND, message: "Synthetic message" });
    expect((await POST(post({ action: "CONTACT_GUEST", commandId: COMMAND, publicBookingId: BOOKING, message: "Synthetic message", expectedSnapshot: SNAPSHOT }))).status).toBe(400);
  });
});
