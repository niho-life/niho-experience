import { createHash } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StoreConflictError, type GuestBookingView } from "@niho-experience/experience-store";

/** 取消 on the guest's booking page (#285 slice 7): the route, the page's copy and the browser call. Synthetic data only. */
const state = vi.hoisted(() => ({
  config: { guestBookingEnabled: true, guestMailEnabled: true, siteUrl: "https://experience.example" },
  cancellations: null as null | Record<string, ReturnType<typeof vi.fn>>,
  submit: null as null | ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<unknown>>>,
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ get config() { return state.config; } }));
vi.mock("@/lib/experience/store-server", () => ({ bookingCancellations: () => state.cancellations }));
vi.mock("@niho-experience/experience-payments", () => ({ submitBookingRefund: (...args: unknown[]) => state.submit!(...args) }));

import { POST as cancel } from "@/app/api/public/bookings/cancel/route";
import { GuestBookingDetails } from "@/components/GuestBookingDetails";
import { cancelBooking } from "./guest-booking-page";

const ORIGIN = "https://experience.example";
const SESSION = "sampleSessionAbcdefghijklmnopqrstuvwxyz0123";
const BOOKING = "0f8fad5b-d9cb-469f-a165-708677289501";
const COMMAND = "6f1c2b9e-3a4d-4c5e-8f70-112233445566";
const REFUND = "7f1c2b9e-3a4d-4c5e-8f70-112233445566";
const COOKIE = `__Host-nb_${createHash("sha256").update(BOOKING).digest("hex").slice(0, 8)}`;
const DEADLINE = "2026-11-12T01:00:00.000Z";
const SUBMISSION = {
  refundId: REFUND, publicBookingId: BOOKING, connectedAccountId: "acct_SampleA0001", stripePaymentRef: "pi_SampleA0001",
  kind: "FULL", amount: 7500, currency: "JPY", refundApplicationFee: true,
};

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/api/public/bookings/cancel`, {
    method: "POST",
    headers: { origin: ORIGIN, "sec-fetch-site": "same-origin", "content-type": "application/json", cookie: `${COOKIE}=${SESSION}`, ...headers },
    body: JSON.stringify(body),
  });
}
const valid = { publicBookingId: BOOKING, commandId: COMMAND, choice: "FULL_REFUND", shownDeadlineUtc: DEADLINE };

let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  state.config = { guestBookingEnabled: true, guestMailEnabled: true, siteUrl: ORIGIN };
  state.cancellations = {
    cancelAsGuest: vi.fn(async () => ({ outcome: "CANCELLED", repeated: false, bookingIds: [BOOKING], refunds: [SUBMISSION] })),
    recordRefundSubmission: vi.fn(async () => "PENDING"),
  };
  state.submit = vi.fn(async () => ({ kind: "accepted", stripeRefundRef: "re_test_Sample1", status: "pending", failureCode: null }));
  vi.stubEnv("EXPERIENCE_STRIPE_PLATFORM_SECRET_KEY", "sk_test_synthetic_platform_key_only");
  errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  errors.mockRestore();
});

describe("POST /api/public/bookings/cancel", () => {
  it("cancels with the session of that booking's cookie, then sends the refund on the seller's account and records Stripe's answer", async () => {
    const response = await cancel(post(valid));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await response.json()).toEqual({ outcome: "CANCELLED" });
    expect(state.cancellations!.cancelAsGuest).toHaveBeenCalledExactlyOnceWith(SESSION, BOOKING, { commandId: COMMAND, choice: "FULL_REFUND", shownDeadlineUtc: DEADLINE });
    expect(state.submit).toHaveBeenCalledExactlyOnceWith({ refund: SUBMISSION, platformStripeKey: "sk_test_synthetic_platform_key_only" });
    expect(state.cancellations!.recordRefundSubmission).toHaveBeenCalledExactlyOnceWith(REFUND, { kind: "accepted", stripeRefundRef: "re_test_Sample1", status: "pending", failureCode: null });
  });

  it("keeps the cancellation when Stripe cannot be reached: the refund stays requested, and nothing about it is logged", async () => {
    state.submit!.mockRejectedValueOnce(new Error(`offline for ${REFUND}`));
    const response = await cancel(post(valid));
    expect(response.status).toBe(200);
    expect(state.cancellations!.recordRefundSubmission).not.toHaveBeenCalled();
    expect(JSON.stringify(errors.mock.calls)).not.toMatch(/7f1c2b9e|0f8fad5b|offline/);
  });

  it("answers an ask, a changed page or a booking that can't be cancelled with its outcome, and sends no refund", async () => {
    for (const outcome of ["REQUESTED", "CHANGED", "NOT_CANCELLABLE"]) {
      state.cancellations!.cancelAsGuest!.mockResolvedValueOnce({ outcome, repeated: false, bookingIds: [], refunds: [] });
      const response = await cancel(post({ ...valid, choice: "REQUEST" }));
      expect(await response.json()).toEqual({ outcome });
    }
    expect(state.submit).not.toHaveBeenCalled();
  });

  it("refuses other sites, malformed bodies and a missing session as the booking page does", async () => {
    expect((await cancel(post(valid, { origin: "https://elsewhere.example" }))).status).toBe(403);
    expect((await cancel(post(valid, { "sec-fetch-site": "cross-site" }))).status).toBe(403);
    for (const body of [
      { ...valid, publicBookingId: "not-a-booking" },
      { ...valid, commandId: "not-a-uuid" },
      { ...valid, choice: "PARTIAL" },
      { ...valid, shownDeadlineUtc: "2026-11-12" },
    ]) {
      expect((await cancel(post(body))).status).toBe(400);
    }
    expect((await cancel(post(valid, { cookie: "" }))).status).toBe(404);
    state.cancellations!.cancelAsGuest!.mockResolvedValueOnce(null);
    expect((await cancel(post(valid))).status).toBe(404);
    expect(state.cancellations!.cancelAsGuest).toHaveBeenCalledOnce();
  });

  it("answers 409 for a command reused with other input, 503 when the store fails, and 404 while a flag is off", async () => {
    state.cancellations!.cancelAsGuest!.mockRejectedValueOnce(new StoreConflictError("The command ID was already used with different input."));
    expect((await cancel(post(valid))).status).toBe(409);
    state.cancellations!.cancelAsGuest!.mockRejectedValueOnce(new Error(`database down ${BOOKING}`));
    expect((await cancel(post(valid))).status).toBe(503);
    expect(JSON.stringify(errors.mock.calls)).not.toMatch(/0f8fad5b|database down/);
    state.config = { ...state.config, guestMailEnabled: false };
    expect((await cancel(post(valid))).status).toBe(404);
  });
});

describe("cancelBooking (the page's call)", () => {
  const reply = (status: number, body?: unknown) => vi.fn(async () => new Response(body === undefined ? null : JSON.stringify(body), { status }));

  it("posts same-origin with the cookie and reads the outcome; a lost answer is a failure to retry with the same command", async () => {
    const fetchImpl = reply(200, { outcome: "CANCELLED" });
    expect(await cancelBooking({ publicBookingId: BOOKING, commandId: COMMAND, choice: "FULL_REFUND", shownDeadlineUtc: DEADLINE }, fetchImpl)).toEqual({ kind: "done", outcome: "CANCELLED" });
    expect(fetchImpl).toHaveBeenCalledWith("/api/public/bookings/cancel", expect.objectContaining({ method: "POST", credentials: "same-origin", referrerPolicy: "same-origin", redirect: "error" }));
    const input = { publicBookingId: BOOKING, commandId: COMMAND, choice: "REQUEST" as const, shownDeadlineUtc: null };
    expect(await cancelBooking(input, reply(404))).toEqual({ kind: "closed" });
    expect(await cancelBooking(input, reply(409))).toEqual({ kind: "conflict" });
    expect(await cancelBooking(input, reply(503))).toEqual({ kind: "failed" });
    expect(await cancelBooking(input, reply(200, { outcome: "SOMETHING" }))).toEqual({ kind: "failed" });
    expect(await cancelBooking(input, vi.fn(async () => { throw new TypeError("offline"); }))).toEqual({ kind: "failed" });
  });
});

describe("the booking page's cancellation section", () => {
  const VIEW: GuestBookingView = {
    publicBookingId: BOOKING, status: "CONFIRMED", experienceTitle: "Synthetic walk", experienceSlug: "sample-walk",
    localDate: "2026-11-14", localStartTime: "10:00", timeZone: "Asia/Tokyo", startUtc: "2026-11-14T01:00:00.000Z", endUtc: "2026-11-14T02:30:00.000Z",
    adultCount: 2, childCount: 1, totalAmount: 7500, currency: "JPY", cancellationPolicy: "FREE_UNTIL_48H", freeCancellationUntilUtc: DEADLINE,
    hostDisplayName: "Sample Host", guestName: "Sample Guest", bookedAtUtc: "2026-10-31T01:00:00.000Z", cancelledAtUtc: null,
    cancelledBy: null, cancellationReason: null, freeCancellationOpen: true, experienceEnded: false, refunds: [], cancellationRequest: null,
  };
  const NOW = new Date("2026-11-01T00:00:00.000Z");
  const page = (booking: Partial<GuestBookingView>) => renderToStaticMarkup(createElement(GuestBookingDetails, { booking: { ...VIEW, ...booking }, now: NOW }));

  it("offers a full refund before the deadline, with the deadline in Japan time", () => {
    const html = page({});
    expect(html).toContain("Cancel and get a full refund");
    expect(html).toContain("You can cancel for free until Thu 12 Nov, 10:00 Japan time. We&#x27;ll refund ¥7,500 in full to the card you paid with.");
    expect(html).not.toContain("Ask to cancel");
    expect(html).not.toContain("Coming soon on this page");
  });

  it("offers asking support after the deadline or with no free cancellation, and says the booking stays confirmed", () => {
    const late = page({ freeCancellationOpen: false });
    expect(late).toContain("Ask to cancel");
    expect(late).toContain("Free cancellation has ended. You can still ask to cancel");
    expect(late).not.toContain("Cancel and get a full refund");
    expect(page({ freeCancellationOpen: false, cancellationPolicy: "NONE", freeCancellationUntilUtc: null })).toContain("This booking is non-refundable. You can still ask to cancel");
    const open = page({ freeCancellationOpen: false, cancellationRequest: { status: "OPEN", requestedAtUtc: "2026-11-13T00:00:00.000Z", declineMessage: null } });
    expect(open).toContain("You asked to cancel on Fri 13 Nov, 09:00 Japan time. NIHO support will reply by email. Your booking stays confirmed until then.");
    expect(open).not.toContain("Ask to cancel<");
    const declined = page({ freeCancellationOpen: false, cancellationRequest: { status: "DECLINED", requestedAtUtc: "2026-11-13T00:00:00.000Z", declineMessage: "Sample answer from support." } });
    expect(declined).toContain("Sample answer from support.");
    expect(declined).toContain("Your booking stays confirmed.");
    expect(page({ freeCancellationOpen: false, experienceEnded: true })).toContain("This experience has ended.");
  });

  it("shows a cancelled booking's refunds as they are, never a refund that has not been made", () => {
    const base = { status: "CANCELLED" as const, freeCancellationOpen: false, cancelledAtUtc: "2026-11-02T00:00:00.000Z", cancelledBy: "HOST" as const, cancellationReason: "WEATHER" };
    const processing = page({ ...base, refunds: [{ status: "PROCESSING", amount: 7500, currency: "JPY", refundedAtUtc: null }] });
    expect(processing).toContain("Sample Host cancelled this booking because of the weather. We&#x27;re very sorry.");
    expect(processing).toContain("A refund of ¥7,500 is on its way to the card you paid with.");
    expect(processing).not.toContain("was refunded");
    const done = page({ ...base, cancelledBy: "GUEST", cancellationReason: "GUEST_REQUEST", refunds: [{ status: "REFUNDED", amount: 7500, currency: "JPY", refundedAtUtc: "2026-11-02T03:00:00.000Z" }] });
    expect(done).toContain("You cancelled this booking.");
    expect(done).toContain("¥7,500 was refunded to the card you paid with on Mon 2 Nov, 12:00 Japan time.");
    expect(page({ ...base, refunds: [{ status: "FAILED", amount: 7500, currency: "JPY", refundedAtUtc: null }] })).toContain("We couldn&#x27;t refund ¥7,500 to your card. NIHO support will email you about it.");
    expect(page({ ...base, cancelledBy: "SUPPORT", cancellationReason: "LATE_PAYMENT", refunds: [] })).toContain("Your payment reached us after your hold on the place ended");
    for (const html of [processing, done]) expect(html).not.toContain("Cancel and get a full refund");
  });
});
