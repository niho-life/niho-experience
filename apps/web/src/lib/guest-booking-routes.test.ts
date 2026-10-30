import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { GuestCheckoutError, StoreConflictError, StoreNotFoundError, type BookingRecord, type GuestBookingStart, type GuestCheckoutErrorCode } from "@niho-experience/experience-store";

/** The public availability and checkout of 旅行者の予約 (#285) against a stubbed store and a stubbed Stripe SDK. */
const state = vi.hoisted(() => ({
  config: { guestBookingEnabled: true, bookingsEnabled: true, siteUrl: "https://experience.example", guestBookingConsentVersion: "sample-terms-2026-10" },
  repository: null as null | Record<string, ReturnType<typeof vi.fn>>,
  stripeKeys: [] as string[],
  stripeCreate: null as null | Mock<(...args: unknown[]) => Promise<unknown>>,
  stripeRetrieve: null as null | Mock<(...args: unknown[]) => Promise<unknown>>,
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ get config() { return state.config; } }));
vi.mock("@/lib/experience/store-server", () => ({ guestBookingRepository: () => state.repository }));
// The real experience-payments runs against this stand-in for the Stripe SDK.
vi.mock("stripe", () => ({
  default: class {
    readonly checkout = { sessions: { create: (...args: unknown[]) => state.stripeCreate!(...args), retrieve: (...args: unknown[]) => state.stripeRetrieve!(...args) } };
    readonly webhooks = {};
    constructor(key: string) {
      state.stripeKeys.push(key);
    }
  },
}));

import { GET as availability } from "@/app/api/public/experiences/[slug]/availability/route";
import { POST as checkout } from "@/app/api/public/experiences/[slug]/checkout/route";

const ORIGIN = "https://experience.example";
const BOOKING_ID = "123e4567-e89b-42d3-a456-426614174285";
const KEY = "00000000-0000-4000-8000-000000000285";
const CONDITIONS = "c0".repeat(32);
const CHECKOUT = {
  offerId: "sample-am",
  occurrenceDate: "2026-11-02",
  adultCount: 2,
  childCount: 0,
  expectedTotalYen: 8000,
  guestName: "Sample Guest",
  guestEmail: "guest@example.com",
  note: "Window seat please",
  answers: [{ questionId: "diet", optionIds: ["veg"] }],
  bookingQuestionsFingerprint: "a".repeat(64),
  consent: { agreedVersion: "sample-terms-2026-10" },
  clientRequestKey: KEY,
  utmSource: "newsletter",
  guestPhone: "+81 90 1234 5678",
  conditionsConsent: { version: CONDITIONS },
};
const AVAILABILITY = {
  generatedAt: "2026-10-31T01:00:00.000Z",
  timeZone: "Asia/Tokyo",
  windowDays: 90,
  occurrences: [{ offerId: "sample-am", date: "2026-11-02", startAt: "2026-11-02T01:30:00.000Z", endAt: "2026-11-02T03:00:00.000Z", bookable: true, seatsLeft: 4, reason: null }],
};

/** A guest hold of two adults at ¥4,000 with support on: NIHO's fee is ¥1,200. */
function started(overrides: Partial<GuestBookingStart> = {}, holdMinutes = 35): GuestBookingStart {
  const now = Date.now();
  const holdExpiresAt = new Date(now + holdMinutes * 60_000).toISOString();
  const booking: BookingRecord = {
    publicBookingId: BOOKING_ID,
    providerId: "provider-sample",
    productId: "tea",
    occurrenceId: "occurrence-sample",
    status: overrides.status ?? "HOLD",
    seats: 2,
    idempotencyKey: `guest-checkout:tea:${KEY}`,
    holdExpiresAtUtc: holdExpiresAt,
    occurrenceSnapshot: {
      occurrenceId: "occurrence-sample", ruleId: "sample-am", sourceLocalDate: "2026-11-02", localDate: "2026-11-02", localStartTime: "10:30",
      timeZone: "Asia/Tokyo", startUtc: "2026-11-02T01:30:00.000Z", endUtc: "2026-11-02T03:00:00.000Z", capacityAtAcceptance: 6, seats: 2,
      acceptedAtUtc: new Date(now).toISOString(),
    },
    pricingSnapshot: {
      currency: "JPY", unitAmount: 4000, seats: 2, totalAmount: 8000, cancellationTermsRef: "terms-v1",
      breakdown: { adultCount: 2, childCount: 0, childUnitAmount: null }, cancellationPolicy: "FREE_UNTIL_24H",
      platformFee: { supportEnabled: true, basisPoints: 1500, amount: 1200 },
    },
    sellerSnapshot: { experienceProviderId: "provider-sample", nihoAccountRef: "niho-sample", stripeConnectAccountRef: "acct_SampleA0001", displayName: "Sample Seller" },
    createdAtUtc: new Date(now).toISOString(),
  };
  return {
    publicBookingId: BOOKING_ID, status: "HOLD", holdExpiresAt, totalAmount: 8000, currency: "JPY", stripeConnectAccountRef: "acct_SampleA0001",
    sellerDisplayName: "Sample Seller", productTitle: "Synthetic tea ceremony", guestEmail: "guest@example.com", checkoutSessionRef: null, booking, ...overrides,
  };
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/api/public/experiences/sample-tea/checkout`, {
    method: "POST",
    headers: { origin: ORIGIN, "sec-fetch-site": "same-origin", "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function get(query = ""): Request {
  return new Request(`${ORIGIN}/api/public/experiences/sample-tea/availability${query}`);
}

const slugParams = (slug = "sample-tea") => ({ params: Promise.resolve({ slug }) });

beforeEach(() => {
  vi.stubEnv("EXPERIENCE_STRIPE_PLATFORM_SECRET_KEY", "sk_test_sample");
  state.config = { guestBookingEnabled: true, bookingsEnabled: true, siteUrl: ORIGIN, guestBookingConsentVersion: "sample-terms-2026-10" };
  state.repository = {
    listPublicAvailability: vi.fn(async () => AVAILABILITY),
    startGuestBooking: vi.fn(async () => started()),
    attachCheckoutSession: vi.fn(async () => undefined),
  };
  state.stripeKeys = [];
  state.stripeCreate = vi.fn(async () => ({ id: "cs_test_sample1", url: "https://checkout.stripe.com/c/pay/cs_test_sample1" }));
  state.stripeRetrieve = vi.fn(async () => ({ id: "cs_test_sample1", status: "open", url: "https://checkout.stripe.com/c/pay/cs_test_sample1", metadata: { booking_id: BOOKING_ID } }));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("GET /api/public/experiences/[slug]/availability", () => {
  it("answers NIHO's availability shape from the store, never cached", async () => {
    const response = await availability(get(), slugParams());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(AVAILABILITY);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(state.repository?.listPublicAvailability).toHaveBeenCalledWith("sample-tea", {});
    await availability(get("?offerId=sample-pm"), slugParams());
    expect(state.repository?.listPublicAvailability).toHaveBeenLastCalledWith("sample-tea", { offerId: "sample-pm" });
  });

  it("is a 404 without a body while off or not for sale here, a 400 for a malformed offer and a 503 on failure", async () => {
    state.repository!.listPublicAvailability!.mockResolvedValueOnce(null);
    const missing = await availability(get(), slugParams());
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe("");
    expect((await availability(get(), slugParams("x".repeat(161)))).status).toBe(404);
    const malformed = await availability(get("?offerId=bad%20offer"), slugParams());
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: { code: "VALIDATION_ERROR", message: expect.any(String) } });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    state.repository!.listPublicAvailability!.mockRejectedValueOnce(new Error("synthetic outage"));
    expect((await availability(get(), slugParams())).status).toBe(503);
    expect(log).toHaveBeenCalledTimes(1);
    state.config = { ...state.config, guestBookingEnabled: false };
    const off = await availability(get(), slugParams());
    expect(off.status).toBe(404);
    expect(await off.text()).toBe("");
  });
});

describe("POST /api/public/experiences/[slug]/checkout", () => {
  it("holds the seats, opens Stripe Checkout on the seller's account with the snapshot's fee, and answers 201", async () => {
    const response = await checkout(post(CHECKOUT), slugParams());
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ checkoutUrl: "https://checkout.stripe.com/c/pay/cs_test_sample1" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(state.repository?.startGuestBooking).toHaveBeenCalledWith({
      slug: "sample-tea",
      offerId: "sample-am",
      occurrenceDate: "2026-11-02",
      adultCount: 2,
      childCount: 0,
      expectedTotalYen: 8000,
      bookingQuestionsFingerprint: "a".repeat(64),
      answers: [{ questionId: "diet", optionIds: ["veg"] }],
      termsConsentVersion: "sample-terms-2026-10",
      currentConsentVersion: "sample-terms-2026-10",
      conditionsConsentVersion: CONDITIONS,
      guestName: "Sample Guest",
      guestEmail: "guest@example.com",
      guestPhone: "+81 90 1234 5678",
      guestLanguage: "EN",
      note: "Window seat please",
      utm: { utmSource: "newsletter" },
      clientRequestKey: KEY,
    });
    expect(state.stripeKeys).toEqual(["sk_test_sample"]);
    const [params, options] = state.stripeCreate!.mock.calls[0]!;
    expect(params).toMatchObject({
      mode: "payment",
      success_url: `${ORIGIN}/booking/return?type=instant`,
      cancel_url: `${ORIGIN}/experiences/sample-tea?checkout=cancelled`,
      customer_email: "guest@example.com",
      payment_intent_data: { application_fee_amount: 1200 },
      metadata: { source: "niho-experience", booking_id: BOOKING_ID },
      line_items: [{ quantity: 1, price_data: { currency: "jpy", unit_amount: 8000 } }],
    });
    expect(options).toEqual({ stripeAccount: "acct_SampleA0001", idempotencyKey: `experience-checkout:${BOOKING_ID}` });
    expect(state.repository?.attachCheckoutSession).toHaveBeenCalledWith(BOOKING_ID, "cs_test_sample1");
  });

  it("drops the UTM fields under Do Not Track, and leaves out what the guest did not send", async () => {
    const plain: Record<string, unknown> = { ...CHECKOUT };
    for (const key of ["utmSource", "guestPhone", "conditionsConsent", "note", "answers"]) delete plain[key];
    await checkout(post({ ...CHECKOUT, utmCampaign: "BAD VALUE" }, { dnt: "1" }), slugParams());
    expect(state.repository?.startGuestBooking).toHaveBeenLastCalledWith(expect.objectContaining({ utm: undefined }));
    await checkout(post(plain), slugParams());
    expect(state.repository?.startGuestBooking).toHaveBeenLastCalledWith(expect.objectContaining({
      utm: {}, guestPhone: null, conditionsConsentVersion: null, note: null, answers: undefined,
    }));
  });

  it("is a 404 while off, takes posts from this site only, and stops for the incident switch", async () => {
    state.config = { ...state.config, guestBookingEnabled: false };
    const off = await checkout(post(CHECKOUT), slugParams());
    expect(off.status).toBe(404);
    expect(await off.text()).toBe("");
    state.config = { ...state.config, guestBookingEnabled: true };
    for (const headers of [{ origin: "https://other.example" }, { origin: "null" }, { "sec-fetch-site": "cross-site" }] as Record<string, string>[]) {
      expect((await checkout(post(CHECKOUT, headers), slugParams())).status).toBe(403);
    }
    expect((await checkout(post(CHECKOUT), slugParams(""))).status).toBe(404);
    state.config = { ...state.config, bookingsEnabled: false };
    const stopped = await checkout(post(CHECKOUT), slugParams());
    expect(stopped.status).toBe(409);
    expect((await stopped.json()).error.code).toBe("UNAVAILABLE");
    expect(state.repository?.startGuestBooking).not.toHaveBeenCalled();
    state.config = { ...state.config, bookingsEnabled: true };
    state.repository = null;
    expect((await checkout(post(CHECKOUT), slugParams())).status).toBe(503);
  });

  it("reads NIHO's closed request strictly and names the field of a wrong type", async () => {
    const shape: [unknown, Record<string, string>?][] = [
      ["{"],
      ["[]"],
      [CHECKOUT, { "content-type": "text/plain" }],
      [{ ...CHECKOUT, guestCountryCode: "JP" }],
      [{ ...CHECKOUT, consent: { agreedVersion: "sample-terms-2026-10", extra: true } }],
      [{ ...CHECKOUT, conditionsConsent: { version: CONDITIONS, text: "x" } }],
      [{ ...CHECKOUT, answers: [{ questionId: "diet", optionIds: ["veg"], label: "Vegetarian" }] }],
    ];
    for (const [body, headers] of shape) {
      const response = await checkout(post(body, headers), slugParams());
      expect(response.status).toBe(400);
      expect((await response.json()).error).toMatchObject({ code: "VALIDATION_ERROR", retryable: false });
    }
    const large = await checkout(post({ ...CHECKOUT, note: "x".repeat(17 * 1024) }), slugParams());
    expect(large.status).toBe(413);
    expect((await large.json()).error.code).toBe("VALIDATION_ERROR");

    const types: [Record<string, unknown>, string][] = [
      [{ adultCount: "2" }, "adultCount"],
      [{ expectedTotalYen: null }, "expectedTotalYen"],
      [{ guestEmail: 7 }, "guestEmail"],
      [{ offerId: undefined }, "offerId"],
      [{ note: 5 }, "note"],
      [{ guestPhone: null }, "guestPhone"],
      [{ consent: "sample-terms-2026-10" }, "consent.agreedVersion"],
      [{ consent: { agreedVersion: 1 } }, "consent.agreedVersion"],
      [{ conditionsConsent: CONDITIONS }, "conditionsConsent"],
      [{ utmMedium: 3 }, "utmMedium"],
    ];
    for (const [change, field] of types) {
      const response = await checkout(post({ ...CHECKOUT, ...change }), slugParams());
      expect(response.status).toBe(422);
      expect((await response.json()).error).toMatchObject({ code: "INPUT_INVALID", field });
    }
    const answers = await checkout(post({ ...CHECKOUT, answers: { diet: "veg" } }), slugParams());
    expect(answers.status).toBe(422);
    expect((await answers.json()).error).toMatchObject({ code: "ANSWERS_INVALID", field: "answers" });
    expect(state.repository?.startGuestBooking).not.toHaveBeenCalled();
  });

  it("answers every refusal of the store with NIHO's status and closed body", async () => {
    const cases: [GuestCheckoutErrorCode, ConstructorParameters<typeof GuestCheckoutError>[1], number][] = [
      ["INPUT_INVALID", { field: "guestEmail" }, 422],
      ["ANSWERS_INVALID", { questionId: "diet", field: "optionIds" }, 422],
      ["CONSENT_OUTDATED", { field: "conditionsConsent.version" }, 422],
      ["OCCURRENCE_INVALID", { occurrenceReason: "CUTOFF" }, 422],
      ["UNAVAILABLE", {}, 409],
      ["FULL", { seatsLeft: 1 }, 409],
      ["HOLD_LIMIT", {}, 409],
      ["QUESTIONS_CHANGED", { questionId: "diet" }, 409],
      ["PRICE_CHANGED", { currentTotalYen: 9000 }, 409],
      ["REQUEST_MISMATCH", {}, 409],
      ["RATE_LIMITED", { retryAfterSeconds: 120 }, 429],
    ];
    for (const [code, details, status] of cases) {
      state.repository!.startGuestBooking!.mockRejectedValueOnce(new GuestCheckoutError(code, details));
      const response = await checkout(post(CHECKOUT), slugParams());
      expect(response.status, code).toBe(status);
      expect(await response.json(), code).toEqual({
        error: {
          code,
          message: expect.any(String),
          retryable: code === "RATE_LIMITED",
          field: details?.field ?? null,
          questionId: details?.questionId ?? null,
          seatsLeft: details?.seatsLeft ?? null,
          currentTotalYen: details?.currentTotalYen ?? null,
          occurrenceReason: details?.occurrenceReason ?? null,
        },
      });
      expect(response.headers.get("retry-after"), code).toBe(code === "RATE_LIMITED" ? "120" : null);
    }
    state.repository!.startGuestBooking!.mockRejectedValueOnce(new StoreNotFoundError("experience for sale"));
    const missing = await checkout(post(CHECKOUT), slugParams());
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe("");
    expect(state.stripeCreate).not.toHaveBeenCalled();
  });

  it("answers a repeated request by the state of its booking", async () => {
    // Paid (or paid and under review): NIHO sends the guest to its booking page; here, the page Stripe returned them to.
    for (const status of ["CONFIRMED", "PAYMENT_REVIEW"] as const) {
      state.repository!.startGuestBooking!.mockResolvedValueOnce(started({ status, checkoutSessionRef: "cs_test_sample1" }));
      const paid = await checkout(post(CHECKOUT), slugParams());
      expect(paid.status, status).toBe(201);
      expect(await paid.json()).toEqual({ checkoutUrl: `${ORIGIN}/booking/return?type=instant` });
    }
    // Expired, cancelled, past its time, or too close to it for a 30-minute Session: the seats are gone.
    for (const start of [started({ status: "EXPIRED" }), started({ status: "CANCELLED" }), started({}, -1), started({}, 20)]) {
      state.repository!.startGuestBooking!.mockResolvedValueOnce(start);
      const gone = await checkout(post(CHECKOUT), slugParams());
      expect(gone.status, start.status).toBe(409);
      expect((await gone.json()).error).toMatchObject({ code: "UNAVAILABLE", retryable: false });
    }
    expect(state.stripeCreate).not.toHaveBeenCalled();
    // Still held with its Session (back from Stripe, a second click): that Session, read back on the seller's account,
    // even with too little of the hold left for a new one. Nothing is created or attached again.
    for (const start of [started({ checkoutSessionRef: "cs_test_sample1" }), started({ checkoutSessionRef: "cs_test_sample1" }, 20)]) {
      state.repository!.startGuestBooking!.mockResolvedValueOnce(start);
      const again = await checkout(post(CHECKOUT), slugParams());
      expect(again.status).toBe(201);
      expect(await again.json()).toEqual({ checkoutUrl: "https://checkout.stripe.com/c/pay/cs_test_sample1" });
    }
    expect(state.stripeRetrieve).toHaveBeenCalledWith("cs_test_sample1", undefined, { stripeAccount: started().booking.sellerSnapshot.stripeConnectAccountRef });
    // Its Session paid before the webhook confirmed the booking: the return page. Its Session over: the seats are gone.
    state.stripeRetrieve!.mockResolvedValueOnce({ id: "cs_test_sample1", status: "complete", url: null, metadata: { booking_id: BOOKING_ID } });
    state.repository!.startGuestBooking!.mockResolvedValueOnce(started({ checkoutSessionRef: "cs_test_sample1" }));
    expect(await (await checkout(post(CHECKOUT), slugParams())).json()).toEqual({ checkoutUrl: `${ORIGIN}/booking/return?type=instant` });
    state.stripeRetrieve!.mockResolvedValueOnce({ id: "cs_test_sample1", status: "expired", url: null, metadata: { booking_id: BOOKING_ID } });
    state.repository!.startGuestBooking!.mockResolvedValueOnce(started({ checkoutSessionRef: "cs_test_sample1" }));
    expect((await (await checkout(post(CHECKOUT), slugParams())).json()).error).toMatchObject({ code: "UNAVAILABLE" });
    // Not readable (Stripe down, or a Session of another booking): retry later.
    state.stripeRetrieve!.mockRejectedValueOnce(new Error("synthetic outage"));
    state.repository!.startGuestBooking!.mockResolvedValueOnce(started({ checkoutSessionRef: "cs_test_sample1" }));
    const failed = await checkout(post(CHECKOUT), slugParams());
    expect(failed.status).toBe(503);
    expect(state.stripeCreate).not.toHaveBeenCalled();
    expect(state.repository?.attachCheckoutSession).not.toHaveBeenCalled();
    // Erased guest data: Stripe gets no address.
    state.repository!.startGuestBooking!.mockResolvedValueOnce(started({ guestEmail: null }));
    await checkout(post(CHECKOUT), slugParams());
    expect("customer_email" in (state.stripeCreate!.mock.calls[0]![0] as object)).toBe(false);
  });

  it("keeps the hold and answers CHECKOUT_UNAVAILABLE when the store or Stripe fails, logging no personal data", async () => {
    const log = [vi.spyOn(console, "error"), vi.spyOn(console, "warn"), vi.spyOn(console, "log"), vi.spyOn(console, "info")]
      .map((spy) => spy.mockImplementation(() => undefined));
    const unavailable = async () => {
      const response = await checkout(post(CHECKOUT), slugParams());
      expect(response.status).toBe(503);
      expect((await response.json()).error).toMatchObject({ code: "CHECKOUT_UNAVAILABLE", retryable: true });
    };
    // Messages that repeat what was sent must not reach the log.
    state.stripeCreate!.mockRejectedValueOnce(Object.assign(new Error("Invalid email: guest@example.com for cs_test_sample1"), { name: "StripeInvalidRequestError" }));
    await unavailable();
    expect(state.repository?.attachCheckoutSession).not.toHaveBeenCalled();
    state.repository!.attachCheckoutSession!.mockRejectedValueOnce(new StoreConflictError("Only an active hold can take a Checkout Session."));
    await unavailable();
    state.repository!.startGuestBooking!.mockRejectedValueOnce(new Error(`duplicate key (guest@example.com, ${KEY})`));
    await unavailable();
    vi.stubEnv("EXPERIENCE_STRIPE_PLATFORM_SECRET_KEY", "");
    await unavailable();
    // Nothing releases the hold on failure: the store has no such call to make.
    expect(Object.keys(state.repository!)).toEqual(["listPublicAvailability", "startGuestBooking", "attachCheckoutSession"]);

    const logged = JSON.stringify(log.flatMap((spy) => spy.mock.calls));
    expect(log[0]!.mock.calls.length).toBeGreaterThanOrEqual(3);
    for (const secret of ["guest@example.com", "Sample Guest", "+81 90", "Window seat", KEY, "cs_test_sample1", "sk_test_sample", "newsletter"]) {
      expect(logged).not.toContain(secret);
    }
  });
});
