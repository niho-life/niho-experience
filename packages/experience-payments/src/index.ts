import Stripe from "stripe";
import type { BookingRecord } from "@niho-experience/experience-store";

const STRIPE_MINIMUM_EXPIRY_SECONDS = 30 * 60;
const STRIPE_MAXIMUM_EXPIRY_SECONDS = 24 * 60 * 60;
const DEFAULT_HOLD_SAFETY_MARGIN_SECONDS = 60;
const MAXIMUM_AMOUNT = 9_999_999_999;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONNECTED_ACCOUNT_ID = /^acct_[A-Za-z0-9]{8,}$/;
const EVENT_ID = /^evt_[A-Za-z0-9]{8,}$/;
const PAYMENT_INTENT_ID = /^pi_[A-Za-z0-9]{8,}$/;
const CURRENCY = /^[A-Z]{3}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CONTROL = /[\u0000-\u001F\u007F]/;

export type PaymentsStripeClient = Pick<Stripe, "checkout" | "webhooks">;

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

export interface VerifiedDirectCheckoutEvent {
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
  if (typeof input.checkoutSessionId !== "string" || !/^cs_[A-Za-z0-9_]{1,250}$/.test(input.checkoutSessionId)) {
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

/** Verifies and validates a Connect Checkout webhook. This function never writes to storage. */
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

  if (event.type !== "checkout.session.completed" && event.type !== "checkout.session.async_payment_succeeded") {
    return null;
  }
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
  if (session.payment_status !== "paid") {
    throw new ExperiencePaymentsValidationError("The Checkout Session is not paid.");
  }

  const metadata = asRecord(session.metadata, "checkout session metadata");
  const metadataKeys = Object.keys(metadata);
  if (metadataKeys.length !== 2 || metadata.source !== "niho-experience" || typeof metadata.booking_id !== "string") {
    throw new ExperiencePaymentsValidationError("Checkout Session metadata is malformed.");
  }
  if (!UUID_V4.test(metadata.booking_id)) {
    throw new ExperiencePaymentsValidationError("Checkout Session booking_id must be a UUID v4.");
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

  const eventDate = new Date(event.created * 1_000);
  if (!Number.isFinite(eventDate.getTime())) {
    throw new ExperiencePaymentsValidationError("The Stripe event time is invalid.");
  }
  const eventOccurredAtUtc = eventDate.toISOString();
  return {
    eventId: event.id,
    eventType: event.type,
    eventOccurredAtUtc,
    connectedAccountId: event.account,
    publicBookingId: metadata.booking_id.toLowerCase(),
    paymentIntentRef: paymentIntentReference(session.payment_intent),
    amountTotal,
    currency: currency.toUpperCase(),
  };
}
