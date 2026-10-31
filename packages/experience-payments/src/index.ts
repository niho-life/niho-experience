import Stripe from "stripe";
import type { BookingRecord, RefundSubmission, StripeRefundAnswer, StripeRefundStatus } from "@niho-experience/experience-store";

const STRIPE_MINIMUM_EXPIRY_SECONDS = 30 * 60;
const STRIPE_MAXIMUM_EXPIRY_SECONDS = 24 * 60 * 60;
const DEFAULT_HOLD_SAFETY_MARGIN_SECONDS = 60;
const MAXIMUM_AMOUNT = 9_999_999_999;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONNECTED_ACCOUNT_ID = /^acct_[A-Za-z0-9]{8,}$/;
const EVENT_ID = /^evt_[A-Za-z0-9]{8,}$/;
const PAYMENT_INTENT_ID = /^pi_[A-Za-z0-9]{8,}$/;
const CHECKOUT_SESSION_ID = /^cs_[A-Za-z0-9_]{1,250}$/;
const REFUND_ID = /^(re|pyr)_[A-Za-z0-9_]{1,250}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REFUND_STATUSES: ReadonlySet<string> = new Set(["pending", "requires_action", "succeeded", "failed", "canceled"]);
const REFUND_EVENTS: ReadonlySet<string> = new Set(["refund.created", "refund.updated", "refund.failed"]);
const FAILURE_CODE = /^[a-z0-9_]{1,80}$/;
const CURRENCY = /^[A-Z]{3}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CONTROL = /[\u0000-\u001F\u007F]/;

export type PaymentsStripeClient = Pick<Stripe, "checkout" | "webhooks" | "refunds">;

export interface CreateDirectCheckoutInput {
  readonly booking: Readonly<BookingRecord>;
  /**
   * A trusted, server-calculated fee in the currency's minor unit. A booking whose pricing snapshot fixes
   * the fee (`platformFee`, every guest booking) is charged that fee: leave this out, or pass the same
   * amount. A guest booking without the snapshot is refused.
   */
  readonly applicationFeeAmount?: number;
  /** An allowlisted server configuration value, such as https://experience.example. */
  readonly returnOrigin: string;
  /** A trusted local path. Query parameters are allowed; fragments and cross-origin URLs are not. */
  readonly returnPath: string;
  /** Where Stripe sends a guest who leaves Checkout: a trusted local path on returnOrigin, as returnPath. */
  readonly cancelPath?: string;
  /** Prefills Stripe's email field. Never put it in metadata; leave it out once the guest data is erased. */
  readonly customerEmail?: string;
  readonly platformStripeKey?: string;
  readonly stripe?: PaymentsStripeClient;
  /** Injectable clock for deterministic tests. */
  readonly now?: Date;
  readonly holdSafetyMarginSeconds?: number;
}

export interface DirectCheckoutResult {
  readonly checkoutSessionId: string;
  readonly checkoutUrl: string;
}

export interface RetrieveDirectCheckoutInput {
  /** The booking the Session was created for; its seller's account holds the Session. */
  readonly booking: Readonly<BookingRecord>;
  readonly checkoutSessionId: string;
  readonly platformStripeKey?: string;
  readonly stripe?: PaymentsStripeClient;
}

/** A Session created before: still payable (its URL), paid, or over. */
export type RetrievedDirectCheckout =
  | { readonly status: "open"; readonly checkoutUrl: string }
  | { readonly status: "complete" }
  | { readonly status: "expired" };

export interface VerifyDirectCheckoutWebhookInput {
  /** Exact, unparsed bytes received from Stripe. */
  readonly rawBody: Uint8Array;
  readonly stripeSignature: string;
  readonly endpointSecret: string;
  readonly platformStripeKey?: string;
  readonly stripe?: PaymentsStripeClient;
}

/** A paid Session: Experience Store's confirmBookingPayment takes it. */
export interface VerifiedDirectCheckoutPaidEvent {
  readonly eventId: string;
  readonly eventType: "checkout.session.completed" | "checkout.session.async_payment_succeeded";
  readonly eventOccurredAtUtc: string;
  readonly connectedAccountId: string;
  readonly publicBookingId: string;
  readonly paymentIntentRef: string;
  readonly amountTotal: number;
  /** Uppercase ISO currency, matching Experience Store snapshots. */
  readonly currency: string;
}

/**
 * A Session that ended unpaid (#285 slice 4): it expired, or its delayed payment failed. Experience Store's
 * GuestBookingRepository.releaseGuestHold takes it. It has no payment fields.
 */
export interface VerifiedDirectCheckoutEndedEvent {
  readonly eventId: string;
  readonly eventType: "checkout.session.expired" | "checkout.session.async_payment_failed";
  readonly eventOccurredAtUtc: string;
  readonly connectedAccountId: string;
  readonly publicBookingId: string;
  readonly checkoutSessionId: string;
}

/**
 * A refund this service made (#285 slice 7): its metadata names the booking and our refund. Experience Store's
 * BookingCancellations.applyRefundEvent takes it. A refund made elsewhere (the Dashboard, NIHO) is not one.
 */
export interface VerifiedRefundEvent {
  readonly eventId: string;
  readonly eventType: "refund.created" | "refund.updated" | "refund.failed";
  readonly eventOccurredAtUtc: string;
  readonly connectedAccountId: string;
  readonly publicBookingId: string;
  /** Ours (booking_refunds.id). */
  readonly refundId: string;
  readonly stripeRefundRef: string;
  readonly paymentIntentRef: string;
  readonly amount: number;
  /** Uppercase ISO currency. */
  readonly currency: string;
  readonly status: StripeRefundStatus;
  /** Stripe's failure_reason when it failed; null otherwise. */
  readonly failureCode: string | null;
}

export type VerifiedDirectCheckoutEvent = VerifiedDirectCheckoutPaidEvent | VerifiedDirectCheckoutEndedEvent | VerifiedRefundEvent;

/** Tells the kinds apart (each kind's eventType is a union, so comparing it narrows only one way). */
export function isEndedCheckoutEvent(event: VerifiedDirectCheckoutEvent): event is VerifiedDirectCheckoutEndedEvent {
  return event.eventType === "checkout.session.expired" || event.eventType === "checkout.session.async_payment_failed";
}

export function isRefundEvent(event: VerifiedDirectCheckoutEvent): event is VerifiedRefundEvent {
  return REFUND_EVENTS.has(event.eventType);
}

export interface SubmitBookingRefundInput {
  /** What BookingCancellations returned: every field comes from the stored booking and refund. */
  readonly refund: RefundSubmission;
  readonly platformStripeKey?: string;
  readonly stripe?: PaymentsStripeClient;
}

export class ExperiencePaymentsValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ExperiencePaymentsValidationError";
  }
}

/** The hold ends too soon for a Checkout Session (Stripe's 30-minute minimum plus the safety margin). */
export class ExperiencePaymentsHoldTooShortError extends ExperiencePaymentsValidationError {
  constructor() {
    super("The booking hold must remain valid beyond Stripe's 30-minute minimum plus the safety margin.");
    this.name = "ExperiencePaymentsHoldTooShortError";
  }
}

function resolveStripeClient(
  platformStripeKey: string | undefined,
  injected: PaymentsStripeClient | undefined,
): PaymentsStripeClient {
  if (injected !== undefined && platformStripeKey !== undefined) {
    throw new ExperiencePaymentsValidationError("Provide either platformStripeKey or stripe, not both.");
  }
  if (injected !== undefined) return injected;
  if (platformStripeKey === undefined || platformStripeKey.trim().length === 0) {
    throw new ExperiencePaymentsValidationError("A platform Stripe key or injected Stripe client is required.");
  }
  return new Stripe(platformStripeKey);
}

function assertPositiveAmount(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAXIMUM_AMOUNT) {
    throw new ExperiencePaymentsValidationError(`${field} must be a positive safe integer in minor currency units.`);
  }
}

function assertBookingForCheckout(booking: Readonly<BookingRecord>): void {
  if (!UUID_V4.test(booking.publicBookingId)) {
    throw new ExperiencePaymentsValidationError("booking.publicBookingId must be a UUID v4.");
  }
  if (booking.status !== "HOLD") {
    throw new ExperiencePaymentsValidationError("Only a held booking can start Checkout.");
  }
  if (!CONNECTED_ACCOUNT_ID.test(booking.sellerSnapshot.stripeConnectAccountRef)) {
    throw new ExperiencePaymentsValidationError("The booking seller snapshot has an invalid connected account reference.");
  }
  assertPositiveAmount(booking.pricingSnapshot.unitAmount, "booking.pricingSnapshot.unitAmount");
  assertPositiveAmount(booking.pricingSnapshot.totalAmount, "booking.pricingSnapshot.totalAmount");
  if (!CURRENCY.test(booking.pricingSnapshot.currency)) {
    throw new ExperiencePaymentsValidationError("The booking pricing snapshot currency must be three uppercase letters.");
  }
  if (
    !Number.isInteger(booking.pricingSnapshot.seats) ||
    booking.pricingSnapshot.seats <= 0 ||
    booking.pricingSnapshot.seats !== booking.seats ||
    booking.occurrenceSnapshot.seats !== booking.seats
  ) {
    throw new ExperiencePaymentsValidationError("The booking seat count does not match its snapshots.");
  }
  if (!Number.isSafeInteger(expectedSnapshotTotal(booking)) || expectedSnapshotTotal(booking) !== booking.pricingSnapshot.totalAmount) {
    throw new ExperiencePaymentsValidationError("The booking pricing snapshot total is inconsistent.");
  }
}

/** unitAmount × seats, or for a guest booking (#285) adults at unitAmount plus children at their own price. */
function expectedSnapshotTotal(booking: Readonly<BookingRecord>): number {
  const pricing = booking.pricingSnapshot;
  const breakdown = pricing.breakdown;
  if (breakdown === undefined) return pricing.unitAmount * pricing.seats;
  const { adultCount, childCount, childUnitAmount } = breakdown;
  if (
    !Number.isInteger(adultCount) || !Number.isInteger(childCount) || adultCount < 0 || childCount < 0 ||
    adultCount + childCount !== pricing.seats || (childCount > 0 && childUnitAmount === null) ||
    (childUnitAmount !== null && (!Number.isSafeInteger(childUnitAmount) || childUnitAmount < 0))
  ) {
    return Number.NaN;
  }
  return pricing.unitAmount * adultCount + (childUnitAmount ?? 0) * childCount;
}

function checkoutExpiry(
  booking: Readonly<BookingRecord>,
  now: Date,
  holdSafetyMarginSeconds: number,
): number {
  const nowMilliseconds = now.getTime();
  const holdExpiresMilliseconds = Date.parse(booking.holdExpiresAtUtc);
  if (!Number.isFinite(nowMilliseconds) || !Number.isFinite(holdExpiresMilliseconds)) {
    throw new ExperiencePaymentsValidationError("Checkout time and hold expiry must be valid instants.");
  }
  if (!Number.isSafeInteger(holdSafetyMarginSeconds) || holdSafetyMarginSeconds <= 0) {
    throw new ExperiencePaymentsValidationError("holdSafetyMarginSeconds must be a positive safe integer.");
  }

  const nowSeconds = Math.floor(nowMilliseconds / 1_000);
  const beforeHoldSeconds = Math.floor(holdExpiresMilliseconds / 1_000) - holdSafetyMarginSeconds;
  const expiresAt = Math.min(beforeHoldSeconds, nowSeconds + STRIPE_MAXIMUM_EXPIRY_SECONDS);
  if (expiresAt < nowSeconds + STRIPE_MINIMUM_EXPIRY_SECONDS) throw new ExperiencePaymentsHoldTooShortError();
  if (expiresAt * 1_000 >= holdExpiresMilliseconds) {
    throw new ExperiencePaymentsValidationError("Checkout must expire before the booking hold.");
  }
  return expiresAt;
}

function trustedOrigin(returnOrigin: string): URL {
  let origin: URL;
  try {
    origin = new URL(returnOrigin);
  } catch (error) {
    throw new ExperiencePaymentsValidationError("returnOrigin must be an absolute URL.", { cause: error });
  }
  const isLocalHttp = origin.protocol === "http:" && (origin.hostname === "localhost" || origin.hostname === "127.0.0.1");
  if (origin.protocol !== "https:" && !isLocalHttp) {
    throw new ExperiencePaymentsValidationError("returnOrigin must use HTTPS (HTTP is allowed only for localhost).");
  }
  if (origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new ExperiencePaymentsValidationError("returnOrigin must contain only a trusted origin.");
  }
  return origin;
}

/** A local path (returnPath or cancelPath) on the trusted origin. */
function trustedUrl(origin: URL, path: string, field: "returnPath" | "cancelPath"): string {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || path.includes("\\")) {
    throw new ExperiencePaymentsValidationError(`${field} must be a same-origin absolute path.`);
  }

  let url: URL;
  try {
    url = new URL(path, origin);
  } catch (error) {
    throw new ExperiencePaymentsValidationError(`${field} is invalid.`, { cause: error });
  }
  if (url.origin !== origin.origin || url.hash) {
    throw new ExperiencePaymentsValidationError(`${field} must stay on the trusted origin and contain no fragment.`);
  }
  return url.href;
}

/**
 * The fee fixed in the booking's pricing snapshot (guest bookings, #285), or for a booking without one the
 * caller's trusted amount. Either way at least 1 and below the total, as Stripe requires.
 */
function applicationFee(booking: Readonly<BookingRecord>, requested: number | undefined): number {
  const snapshot = booking.pricingSnapshot.platformFee;
  let fee: number;
  if (snapshot !== undefined) {
    assertPositiveAmount(snapshot.amount, "booking.pricingSnapshot.platformFee.amount");
    if (requested !== undefined && requested !== snapshot.amount) {
      throw new ExperiencePaymentsValidationError("applicationFeeAmount must equal the booking's platform fee snapshot.");
    }
    fee = snapshot.amount;
  } else if (booking.pricingSnapshot.breakdown !== undefined) {
    throw new ExperiencePaymentsValidationError("A guest booking must carry its platform fee snapshot.");
  } else if (requested === undefined) {
    throw new ExperiencePaymentsValidationError("applicationFeeAmount is required for a booking without a platform fee snapshot.");
  } else {
    assertPositiveAmount(requested, "applicationFeeAmount");
    fee = requested;
  }
  if (fee >= booking.pricingSnapshot.totalAmount) {
    throw new ExperiencePaymentsValidationError("applicationFeeAmount must be less than the booking total.");
  }
  return fee;
}

/** The guest's address for Stripe's own email field. The message never repeats the value. */
function checkoutEmail(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length < 3 || value.length > 254 || !EMAIL.test(value) || CONTROL.test(value)) {
    throw new ExperiencePaymentsValidationError("customerEmail must be an email address.");
  }
  return value;
}

function snapshotTitle(booking: Readonly<BookingRecord>): string {
  const occurrence = booking.occurrenceSnapshot;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(occurrence.localDate) || !/^\d{2}:\d{2}$/.test(occurrence.localStartTime)) {
    throw new ExperiencePaymentsValidationError("The booking occurrence snapshot has an invalid local date or time.");
  }
  return `Experience booking — ${occurrence.localDate} ${occurrence.localStartTime}`;
}

/**
 * Creates a Stripe-hosted, card-only Checkout Session as a Direct charge.
 * All charge-defining fields, the application fee included, come from the immutable booking snapshots.
 * The idempotency key is the booking's, so calling again for the same booking returns the same Session.
 */
export async function createDirectCheckout(input: CreateDirectCheckoutInput): Promise<DirectCheckoutResult> {
  assertBookingForCheckout(input.booking);
  const applicationFeeAmount = applicationFee(input.booking, input.applicationFeeAmount);
  const customerEmail = checkoutEmail(input.customerEmail);

  const stripe = resolveStripeClient(input.platformStripeKey, input.stripe);
  const expiresAt = checkoutExpiry(
    input.booking,
    input.now ?? new Date(),
    input.holdSafetyMarginSeconds ?? DEFAULT_HOLD_SAFETY_MARGIN_SECONDS,
  );
  const origin = trustedOrigin(input.returnOrigin);
  const successUrl = trustedUrl(origin, input.returnPath, "returnPath");
  const cancelUrl = input.cancelPath === undefined ? undefined : trustedUrl(origin, input.cancelPath, "cancelPath");
  const bookingId = input.booking.publicBookingId.toLowerCase();
  const session = await stripe.checkout.sessions.create(
    {
      mode: "payment",
      payment_method_types: ["card"],
      success_url: successUrl,
      ...(cancelUrl === undefined ? {} : { cancel_url: cancelUrl }),
      ...(customerEmail === undefined ? {} : { customer_email: customerEmail }),
      expires_at: expiresAt,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: input.booking.pricingSnapshot.currency.toLowerCase(),
            unit_amount: input.booking.pricingSnapshot.totalAmount,
            product_data: { name: snapshotTitle(input.booking) },
          },
        },
      ],
      metadata: { source: "niho-experience", booking_id: bookingId },
      payment_intent_data: { application_fee_amount: applicationFeeAmount },
    },
    {
      stripeAccount: input.booking.sellerSnapshot.stripeConnectAccountRef,
      idempotencyKey: `experience-checkout:${bookingId}`,
    },
  );

  if (session.id.length === 0 || session.url === null || session.url.length === 0) {
    throw new ExperiencePaymentsValidationError("Stripe returned a Checkout Session without a redirect URL.");
  }
  return { checkoutSessionId: session.id, checkoutUrl: session.url };
}

/**
 * Reads back the Checkout Session created for a booking, on the seller's account, so a repeated request
 * returns the same Session even after the hold is too short for a new one. A Session of another booking
 * is refused.
 */
export async function retrieveDirectCheckout(input: RetrieveDirectCheckoutInput): Promise<RetrievedDirectCheckout> {
  if (typeof input.checkoutSessionId !== "string" || !CHECKOUT_SESSION_ID.test(input.checkoutSessionId)) {
    throw new ExperiencePaymentsValidationError("checkoutSessionId is malformed.");
  }
  const stripe = resolveStripeClient(input.platformStripeKey, input.stripe);
  const session = await stripe.checkout.sessions.retrieve(input.checkoutSessionId, undefined, {
    stripeAccount: input.booking.sellerSnapshot.stripeConnectAccountRef,
  });
  if (session.id !== input.checkoutSessionId || session.metadata?.booking_id !== input.booking.publicBookingId.toLowerCase()) {
    throw new ExperiencePaymentsValidationError("The Checkout Session belongs to another booking.");
  }
  if (session.status === "complete") return { status: "complete" };
  if (session.status === "open" && typeof session.url === "string" && session.url.length > 0) return { status: "open", checkoutUrl: session.url };
  return { status: "expired" };
}

function assertRefundSubmission(refund: RefundSubmission): void {
  if (typeof refund?.refundId !== "string" || !UUID.test(refund.refundId)) throw new ExperiencePaymentsValidationError("refund.refundId must be a UUID.");
  if (typeof refund.publicBookingId !== "string" || !UUID_V4.test(refund.publicBookingId)) throw new ExperiencePaymentsValidationError("refund.publicBookingId must be a UUID v4.");
  if (typeof refund.connectedAccountId !== "string" || !CONNECTED_ACCOUNT_ID.test(refund.connectedAccountId)) throw new ExperiencePaymentsValidationError("refund.connectedAccountId is malformed.");
  if (typeof refund.stripePaymentRef !== "string" || !PAYMENT_INTENT_ID.test(refund.stripePaymentRef)) throw new ExperiencePaymentsValidationError("refund.stripePaymentRef is malformed.");
  assertPositiveAmount(refund.amount, "refund.amount");
  if (typeof refund.currency !== "string" || !CURRENCY.test(refund.currency)) throw new ExperiencePaymentsValidationError("refund.currency must be three uppercase letters.");
  if (refund.kind !== "FULL" && refund.kind !== "PARTIAL") throw new ExperiencePaymentsValidationError("refund.kind must be FULL or PARTIAL.");
  // NIHO's fee goes back with a full refund only; a partial one keeps it (docs/guest-booking.md).
  if (refund.refundApplicationFee !== (refund.kind === "FULL")) throw new ExperiencePaymentsValidationError("refund.refundApplicationFee must be true for a full refund only.");
}

function refundStatusOf(value: unknown): StripeRefundStatus {
  if (value === null || value === undefined) return "pending";
  if (typeof value !== "string" || !REFUND_STATUSES.has(value)) throw new ExperiencePaymentsValidationError("The refund status is unknown.");
  return value as StripeRefundStatus;
}

function failureCodeOf(value: unknown): string | null {
  return typeof value === "string" && FAILURE_CODE.test(value) ? value : null;
}

/** Stripe refused the request for good (a 4xx that is not a conflict or a limit): sending it again changes nothing. */
function definitiveRefusal(error: unknown): string | null {
  const type = (error as { type?: unknown } | null)?.type;
  if (type !== "StripeInvalidRequestError" && type !== "StripePermissionError") return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && FAILURE_CODE.test(code) ? code : type === "StripePermissionError" ? "permission_denied" : "invalid_request";
}

/**
 * Sends one refund to Stripe on the seller's account (Direct charge) for the booking's PaymentIntent (#285 slice 7).
 * It looks for the refund at Stripe first (by our refund ID in its metadata), so sending it again, also after
 * Stripe's idempotency keys expired, never makes a second refund; otherwise it creates it with our refund ID as the
 * idempotency key. NIHO's fee goes back with every refund, in proportion to it (refund_application_fee). Returns Stripe's answer for
 * BookingCancellations.recordRefundSubmission: accepted (with Stripe's status; pending is not done), or refused for
 * good. Any other failure (network, Stripe's 5xx, a limit, a conflict) throws: the refund stays requested and is
 * sent again later.
 */
export async function submitBookingRefund(input: SubmitBookingRefundInput): Promise<StripeRefundAnswer> {
  const refund = input.refund;
  assertRefundSubmission(refund);
  const stripe = resolveStripeClient(input.platformStripeKey, input.stripe);
  const options = { stripeAccount: refund.connectedAccountId };
  const existing = await stripe.refunds.list({ payment_intent: refund.stripePaymentRef, limit: 100 }, options);
  const found = existing.data.find((item) => item.metadata?.refund_id === refund.refundId);
  let created: Stripe.Refund;
  if (found) {
    created = found;
  } else {
    try {
      created = await stripe.refunds.create(
        {
          payment_intent: refund.stripePaymentRef,
          amount: refund.amount,
          refund_application_fee: refund.refundApplicationFee,
          metadata: { source: "niho-experience", booking_id: refund.publicBookingId.toLowerCase(), refund_id: refund.refundId.toLowerCase() },
        },
        { ...options, idempotencyKey: `experience-refund:${refund.refundId.toLowerCase()}` },
      );
    } catch (error) {
      const refused = definitiveRefusal(error);
      if (refused !== null) return { kind: "rejected", failureCode: refused };
      throw error;
    }
  }
  if (typeof created.id !== "string" || !REFUND_ID.test(created.id)) throw new ExperiencePaymentsValidationError("Stripe returned a refund without a valid ID.");
  if (created.amount !== refund.amount) throw new ExperiencePaymentsValidationError("Stripe returned a refund of another amount.");
  return { kind: "accepted", stripeRefundRef: created.id, status: refundStatusOf(created.status), failureCode: failureCodeOf(created.failure_reason) };
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ExperiencePaymentsValidationError(`${field} is malformed.`);
  }
  return value as Record<string, unknown>;
}

function paymentIntentReference(value: unknown): string {
  const reference = typeof value === "string" ? value : asRecord(value, "payment_intent").id;
  if (typeof reference !== "string" || !PAYMENT_INTENT_ID.test(reference)) {
    throw new ExperiencePaymentsValidationError("payment_intent is missing or malformed.");
  }
  return reference;
}

interface CheckoutEventEnvelope {
  readonly eventId: string;
  readonly eventOccurredAtUtc: string;
  readonly connectedAccountId: string;
  readonly publicBookingId: string;
  readonly session: Record<string, unknown>;
}

/**
 * The checks every Checkout event of this service passes, whatever its type: the event ID, connected
 * account and time, a payment Session, and metadata naming one booking. null for another service's Session.
 */
function checkoutEventEnvelope(event: Stripe.Event): CheckoutEventEnvelope | null {
  if (!EVENT_ID.test(event.id)) {
    throw new ExperiencePaymentsValidationError("The Stripe event ID is malformed.");
  }
  if (event.account === undefined || !CONNECTED_ACCOUNT_ID.test(event.account)) {
    throw new ExperiencePaymentsValidationError("A valid connected account ID is required on the Stripe event.");
  }
  if (!Number.isSafeInteger(event.created) || event.created <= 0) {
    throw new ExperiencePaymentsValidationError("The Stripe event time is invalid.");
  }

  const session = asRecord(event.data.object, "checkout session");
  if (session.object !== "checkout.session" || session.mode !== "payment") {
    throw new ExperiencePaymentsValidationError("The Stripe event does not contain a payment Checkout Session.");
  }
  const metadataValue = session.metadata;
  if (metadataValue === null || typeof metadataValue !== "object" || Array.isArray(metadataValue) || (metadataValue as Record<string, unknown>).source !== "niho-experience") return null;

  const metadata = asRecord(session.metadata, "checkout session metadata");
  const metadataKeys = Object.keys(metadata);
  if (metadataKeys.length !== 2 || metadata.source !== "niho-experience" || typeof metadata.booking_id !== "string") {
    throw new ExperiencePaymentsValidationError("Checkout Session metadata is malformed.");
  }
  if (!UUID_V4.test(metadata.booking_id)) {
    throw new ExperiencePaymentsValidationError("Checkout Session booking_id must be a UUID v4.");
  }

  const eventDate = new Date(event.created * 1_000);
  if (!Number.isFinite(eventDate.getTime())) {
    throw new ExperiencePaymentsValidationError("The Stripe event time is invalid.");
  }
  return {
    eventId: event.id,
    eventOccurredAtUtc: eventDate.toISOString(),
    connectedAccountId: event.account,
    publicBookingId: metadata.booking_id.toLowerCase(),
    session,
  };
}

/** The checks every event of this service passes: its ID, connected account and time. */
function eventBasics(event: Stripe.Event): { eventId: string; eventOccurredAtUtc: string; connectedAccountId: string } {
  if (!EVENT_ID.test(event.id)) {
    throw new ExperiencePaymentsValidationError("The Stripe event ID is malformed.");
  }
  if (event.account === undefined || !CONNECTED_ACCOUNT_ID.test(event.account)) {
    throw new ExperiencePaymentsValidationError("A valid connected account ID is required on the Stripe event.");
  }
  if (!Number.isSafeInteger(event.created) || event.created <= 0) {
    throw new ExperiencePaymentsValidationError("The Stripe event time is invalid.");
  }
  return { eventId: event.id, eventOccurredAtUtc: new Date(event.created * 1_000).toISOString(), connectedAccountId: event.account };
}

/**
 * A refund event of this service (#285 slice 7): a Refund whose metadata says niho-experience and names the booking
 * and our refund, exactly. null for a refund made elsewhere (no such metadata): this service did not make it.
 */
function refundEvent(event: Stripe.Event, eventType: VerifiedRefundEvent["eventType"]): VerifiedRefundEvent | null {
  const basics = eventBasics(event);
  const refund = asRecord(event.data.object, "refund");
  if (refund.object !== "refund") throw new ExperiencePaymentsValidationError("The Stripe event does not contain a Refund.");
  const metadataValue = refund.metadata;
  if (metadataValue === null || typeof metadataValue !== "object" || Array.isArray(metadataValue) || (metadataValue as Record<string, unknown>).source !== "niho-experience") return null;
  const metadata = metadataValue as Record<string, unknown>;
  if (Object.keys(metadata).length !== 3 || typeof metadata.booking_id !== "string" || typeof metadata.refund_id !== "string") {
    throw new ExperiencePaymentsValidationError("Refund metadata is malformed.");
  }
  if (!UUID_V4.test(metadata.booking_id) || !UUID.test(metadata.refund_id)) throw new ExperiencePaymentsValidationError("Refund metadata IDs are malformed.");
  if (typeof refund.id !== "string" || !REFUND_ID.test(refund.id)) throw new ExperiencePaymentsValidationError("The Refund ID is malformed.");
  if (typeof refund.amount !== "number") throw new ExperiencePaymentsValidationError("The Refund amount is missing.");
  assertPositiveAmount(refund.amount, "refund amount");
  const currency = refund.currency;
  if (typeof currency !== "string" || !CURRENCY.test(currency.toUpperCase())) throw new ExperiencePaymentsValidationError("The Refund currency is invalid.");
  return {
    ...basics,
    eventType,
    publicBookingId: metadata.booking_id.toLowerCase(),
    refundId: metadata.refund_id.toLowerCase(),
    stripeRefundRef: refund.id,
    paymentIntentRef: paymentIntentReference(refund.payment_intent),
    amount: refund.amount,
    currency: currency.toUpperCase(),
    status: refundStatusOf(refund.status),
    failureCode: failureCodeOf(refund.failure_reason),
  };
}

/**
 * Verifies and validates a Connect webhook of this service. This function never writes to storage.
 * A paid Session (completed, or a delayed payment that succeeded) returns the payment fields; a Session
 * that ended unpaid (expired, or a delayed payment that failed) returns its Session ID instead, so the
 * caller can release that hold. A refund this service made (refund.created, refund.updated, refund.failed,
 * #285 slice 7) returns its status for the booking's refund. Any other event (charge.refunded among them:
 * its charge carries none of this service's metadata), or another service's Session or refund, returns null.
 */
export function verifyDirectCheckoutWebhook(
  input: VerifyDirectCheckoutWebhookInput,
): VerifiedDirectCheckoutEvent | null {
  if (input.rawBody.byteLength === 0) {
    throw new ExperiencePaymentsValidationError("The raw webhook body is required.");
  }
  if (input.stripeSignature.length === 0 || input.endpointSecret.length === 0) {
    throw new ExperiencePaymentsValidationError("Stripe signature and endpoint secret are required.");
  }

  const stripe = resolveStripeClient(input.platformStripeKey, input.stripe);
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(Buffer.from(input.rawBody), input.stripeSignature, input.endpointSecret);
  } catch (error) {
    throw new ExperiencePaymentsValidationError("Stripe webhook signature verification failed.", { cause: error });
  }

  if (event.type === "refund.created" || event.type === "refund.updated" || event.type === "refund.failed") {
    return refundEvent(event, event.type);
  }
  if (event.type === "checkout.session.expired" || event.type === "checkout.session.async_payment_failed") {
    const envelope = checkoutEventEnvelope(event);
    if (envelope === null) return null;
    // An ended Session never gives back the seats of a paid one.
    if (envelope.session.payment_status === "paid") {
      throw new ExperiencePaymentsValidationError("The ended Checkout Session is paid.");
    }
    const checkoutSessionId = envelope.session.id;
    if (typeof checkoutSessionId !== "string" || !CHECKOUT_SESSION_ID.test(checkoutSessionId)) {
      throw new ExperiencePaymentsValidationError("The Checkout Session ID is malformed.");
    }
    return {
      eventId: envelope.eventId,
      eventType: event.type,
      eventOccurredAtUtc: envelope.eventOccurredAtUtc,
      connectedAccountId: envelope.connectedAccountId,
      publicBookingId: envelope.publicBookingId,
      checkoutSessionId,
    };
  }
  if (event.type !== "checkout.session.completed" && event.type !== "checkout.session.async_payment_succeeded") {
    return null;
  }
  const envelope = checkoutEventEnvelope(event);
  if (envelope === null) return null;
  const { session } = envelope;
  if (session.payment_status !== "paid") {
    throw new ExperiencePaymentsValidationError("The Checkout Session is not paid.");
  }

  if (typeof session.amount_total !== "number") {
    throw new ExperiencePaymentsValidationError(
      "checkout session amount_total must be a positive safe integer in minor currency units.",
    );
  }
  const amountTotal = session.amount_total;
  assertPositiveAmount(amountTotal, "checkout session amount_total");
  const currency = session.currency;
  if (typeof currency !== "string" || !CURRENCY.test(currency.toUpperCase())) {
    throw new ExperiencePaymentsValidationError("Checkout Session currency is invalid.");
  }

  return {
    eventId: envelope.eventId,
    eventType: event.type,
    eventOccurredAtUtc: envelope.eventOccurredAtUtc,
    connectedAccountId: envelope.connectedAccountId,
    publicBookingId: envelope.publicBookingId,
    paymentIntentRef: paymentIntentReference(session.payment_intent),
    amountTotal,
    currency: currency.toUpperCase(),
  };
}

/* ---------- the seller's connected account (#285 slice 9: the operator's registration) ---------- */

/** The part of Stripe the account check uses (the platform key reads its connected accounts). */
export type ConnectedAccountStripeClient = Pick<Stripe, "accounts">;

export interface RetrieveConnectedAccountInput {
  readonly accountId: string;
  readonly platformStripeKey?: string;
  readonly stripe?: ConnectedAccountStripeClient;
}

/** What the operator may see of the account: the last 4 characters of its ID and the facts checked, nothing else. */
export interface ConnectedAccountSummary {
  readonly idLast4: string;
  readonly country: string | null;
  readonly defaultCurrency: string | null;
  readonly chargesEnabled: boolean;
  readonly payoutsEnabled: boolean;
  readonly detailsSubmitted: boolean;
}

export type ConnectedAccountProblem = "CHARGES_DISABLED" | "PAYOUTS_DISABLED" | "DETAILS_NOT_SUBMITTED" | "NOT_JAPAN" | "NOT_JPY";

export type ConnectedAccountCheck =
  | { readonly kind: "ready"; readonly account: ConnectedAccountSummary }
  | { readonly kind: "not_ready"; readonly account: ConnectedAccountSummary; readonly problems: readonly ConnectedAccountProblem[] }
  /** Stripe would not show the account to this platform key: not connected to the platform, or the key may not read accounts. */
  | { readonly kind: "unreachable" };

function accountsClient(platformStripeKey: string | undefined, injected: ConnectedAccountStripeClient | undefined): ConnectedAccountStripeClient {
  if (injected !== undefined && platformStripeKey !== undefined) {
    throw new ExperiencePaymentsValidationError("Provide either platformStripeKey or stripe, not both.");
  }
  if (injected !== undefined) return injected;
  if (platformStripeKey === undefined || platformStripeKey.trim().length === 0) {
    throw new ExperiencePaymentsValidationError("A platform Stripe key or injected Stripe client is required.");
  }
  return new Stripe(platformStripeKey);
}

/** Stripe answered that this key cannot see the account (or that it does not exist for this platform). */
function accountOutOfReach(error: unknown): boolean {
  const type = (error as { type?: unknown } | null)?.type;
  if (type === "StripePermissionError") return true;
  const code = (error as { code?: unknown } | null)?.code;
  return type === "StripeInvalidRequestError" && (code === "resource_missing" || code === "account_invalid");
}

/**
 * Reads a seller's connected account with the experience platform key (owner decision 2026-10-31, #330: the
 * account is checked directly with Stripe, not through NIHO). It is ready to take this site's Direct charges in
 * JPY when Stripe shows it to the platform and it has charges and payouts enabled, its details submitted, Japan
 * as its country and JPY as its default currency. Returns no other account detail. A network, key or Stripe
 * failure other than "cannot see this account" throws.
 */
export async function retrieveConnectedAccount(input: RetrieveConnectedAccountInput): Promise<ConnectedAccountCheck> {
  if (typeof input.accountId !== "string" || !CONNECTED_ACCOUNT_ID.test(input.accountId)) {
    throw new ExperiencePaymentsValidationError("accountId must be a Stripe connected account ID.");
  }
  const stripe = accountsClient(input.platformStripeKey, input.stripe);
  let account: Stripe.Account;
  try {
    account = await stripe.accounts.retrieve(input.accountId);
  } catch (error) {
    if (accountOutOfReach(error)) return { kind: "unreachable" };
    throw error;
  }
  if (account?.id !== input.accountId) throw new ExperiencePaymentsValidationError("Stripe returned another account.");
  const summary: ConnectedAccountSummary = {
    idLast4: input.accountId.slice(-4),
    country: typeof account.country === "string" ? account.country.toUpperCase() : null,
    defaultCurrency: typeof account.default_currency === "string" ? account.default_currency.toLowerCase() : null,
    chargesEnabled: account.charges_enabled === true,
    payoutsEnabled: account.payouts_enabled === true,
    detailsSubmitted: account.details_submitted === true,
  };
  const problems: ConnectedAccountProblem[] = [];
  if (!summary.chargesEnabled) problems.push("CHARGES_DISABLED");
  if (!summary.payoutsEnabled) problems.push("PAYOUTS_DISABLED");
  if (!summary.detailsSubmitted) problems.push("DETAILS_NOT_SUBMITTED");
  if (summary.country !== "JP") problems.push("NOT_JAPAN");
  if (summary.defaultCurrency !== "jpy") problems.push("NOT_JPY");
  return problems.length === 0 ? { kind: "ready", account: summary } : { kind: "not_ready", account: summary, problems };
}
