import { createHash } from "node:crypto";
import {
  addLocalDays,
  assertLocalDate,
  expandOccurrences,
  weekdayOf,
  type AvailabilityReason,
  type Occurrence,
  type OccurrenceOverride,
  type OccurrenceSalesState,
  type ScheduleRule,
  type Weekday,
} from "@niho-experience/experience-domain";
import type { Pool, PoolClient } from "pg";
import {
  BookingUnavailableError,
  GuestCheckoutError,
  StoreConflictError,
  StoreNotFoundError,
  StoreValidationError,
  type GuestCheckoutOccurrenceReason,
} from "./errors.ts";
import {
  assertSessionWindow,
  countShown,
  cursorAfter,
  decodeBookingCursor,
  hostGuestBookingFromRow,
  hostGuestSessionFromRow,
  listBoundary,
  listLimit,
  publicBookingIdOf,
  requireBookingsOwner,
  selectOne,
  selectSegment,
  selectSessionBookings,
  selectSessions,
  sessionKeyOf,
  sessionWindowEnd,
  type HostGuestBooking,
  type HostGuestBookingListOptions,
  type HostGuestBookingPage,
  type HostGuestSession,
  type HostGuestSessionKey,
  type HostGuestSessionListOptions,
} from "./host-guest-bookings.ts";
import { evaluateStoredInventories, lockProviderInventory } from "./inventory.ts";
import { enqueueCalendarRecalculation } from "./inventory-outbox.ts";
import {
  BOOKING_COLUMNS,
  OVERRIDE_COLUMNS,
  PRODUCT_COLUMNS,
  RULE_COLUMNS,
  SALES_STATE_COLUMNS,
  expireLapsedHolds,
  lockBookingIdempotencyKey,
  materializeAndLockOccurrence,
  placeBookingHold,
  requireMembership,
} from "./repository.ts";
import { bookingFromRow, isoValue, overrideFromRow, productFromRow, salesStateFromRow, scheduleRuleFromRow, type DbRow } from "./rows.ts";
import { withTransaction } from "./transaction.ts";
import type { BookingRecord, BookingStatus, GuestCancellationPolicy, HostActor, ProductRecord, StoredScheduleRule } from "./types.ts";
import { assertCanonicalInstant, assertMoney, assertNonEmptyText, assertStoreIdentifier, chargeablePlatformFee } from "./validation.ts";

/**
 * The bounds of the public booking flow. Input bounds follow NIHO's public checkout contract
 * (PublicExperienceCheckoutRequest, PublicExperienceBookingQuestion, docs/api-contract.md) and
 * GUEST_PHONE_LIMITS in packages/api-client/src/journey.ts; migration 0023 keeps the same ones.
 * The hold and request limits are this store's (NIHO's contract does not state its numbers).
 */
export const GUEST_BOOKING_LIMITS = {
  /**
   * 35 minutes: a Stripe Checkout Session lasts 30 minutes at least and experience-payments ends it 60 s
   * before the hold, so the rest (4 minutes) is the time between the hold and the Session's creation.
   */
  defaultHoldSeconds: 2_100,
  /** Availability and checkout cover the Tokyo date of today through 89 days later. */
  windowDays: 90,
  maxPartySize: 500,
  /** Stripe's smallest JPY charge; a product below it is not sold. */
  minimumChargeYen: 50,
  bookingQuestions: 5,
  questionOptionsMin: 2,
  questionOptionsMax: 8,
  shortTextAnswerMaxLength: 200,
  longTextAnswerMaxLength: 1000,
  guestNameMaxLength: 100,
  guestEmailMaxLength: 254,
  noteMaxLength: 500,
  phoneMaxLength: 24,
  phoneMinDigits: 7,
  phoneMaxDigits: 15,
  activeHoldsPerGuestPerProduct: 2,
  activeHoldsPerProduct: 30,
  bookingsPerGuestPerHour: 5,
  /** How many of the provider's lapsed holds a new checkout marks EXPIRED on its way (#285 slice 4). */
  lapsedHoldsExpiredPerCheckout: 100,
} as const;

/** NIHO's fee on a guest booking, in basis points (owner decision 2026-10-31, #285; payment fees included). */
export const PLATFORM_FEE_BASIS_POINTS = { supportOff: 1000, supportOn: 1500 } as const;

/** What NIHO charges a provider on bookings made here (migration 0025). */
export interface ProviderSaleSettings {
  readonly providerId: string;
  /** NIHO support (docs/admin-support.md 支援条件). */
  readonly supportEnabled: boolean;
  readonly platformFeeBasisPoints: 1000 | 1500;
  readonly version: number;
  readonly updatedAtUtc: string;
}

export type BookingQuestionInputType = "SHORT_TEXT" | "LONG_TEXT" | "SINGLE_SELECT" | "MULTI_SELECT";

/** NIHO's PublicExperienceBookingQuestion. */
export interface BookingQuestion {
  readonly id: string;
  readonly prompt: string;
  readonly description: string | null;
  readonly inputType: BookingQuestionInputType;
  readonly required: boolean;
  /** Empty for text questions; 2-8 for select questions. */
  readonly options: readonly { readonly id: string; readonly label: string }[];
}

/** NIHO's PublicExperienceChildPricing. */
export interface ChildPricing {
  readonly priceYen: number;
  readonly minAge: number;
  readonly maxAge: number;
  /** A party of children only is refused. */
  readonly adultRequired: boolean;
}

export interface ProductSaleTermsInput {
  /** null: the product takes no children. */
  readonly childPricing: ChildPricing | null;
  readonly minimumParticipants: number;
  readonly maxPartySize: number;
  readonly cancellationPolicy: GuestCancellationPolicy;
  readonly bookingQuestions: readonly BookingQuestion[];
  /** 参加の条件 (#110): the version a guest must consent to, or null. */
  readonly conditionsVersion: string | null;
}

export interface ProductSaleTerms extends ProductSaleTermsInput {
  readonly providerId: string;
  readonly productId: string;
  readonly bookingQuestionsFingerprint: string;
  readonly version: number;
  readonly updatedAtUtc: string;
}

/** NIHO's PublicExperienceOffer: one active schedule rule of the product. */
export interface PublicBookingOffer {
  readonly id: string;
  readonly name: string;
  readonly shortDescription: string | null;
  readonly pricing: {
    readonly currency: "JPY";
    readonly taxIncluded: true;
    readonly adultPriceYen: number;
    readonly child: ChildPricing | null;
  };
  readonly capacity: number;
  readonly maxPartySize: number;
  readonly minimumParticipants: number;
  readonly durationMinutes: number;
  /** Asia/Tokyo HH:mm. */
  readonly startTime: string;
  /** 0 = Sunday … 6 = Saturday. */
  readonly weekdays: readonly number[];
  readonly cancellationPolicy: { readonly code: GuestCancellationPolicy; readonly freeCancellationHoursBefore: 24 | 48 | null };
  readonly acceptanceMode: "INSTANT";
  readonly bookingQuestions: readonly BookingQuestion[];
  readonly bookingQuestionsFingerprint: string;
}

/** What the booking form needs. providerId and productId are for the server only, never a public response. */
export interface PublicBookingTerms {
  readonly providerId: string;
  readonly productId: string;
  readonly title: string;
  readonly currency: "JPY";
  readonly sellerDisplayName: string;
  readonly offers: readonly PublicBookingOffer[];
  readonly conditionsVersion: string | null;
}

export type PublicOccurrenceReason = "CUTOFF" | "FULL" | "UNAVAILABLE";

/** NIHO's PublicExperienceOccurrence. */
export interface PublicOccurrence {
  readonly offerId: string;
  /** Asia/Tokyo YYYY-MM-DD. */
  readonly date: string;
  readonly startAt: string;
  readonly endAt: string;
  readonly bookable: boolean;
  readonly seatsLeft: number;
  readonly reason: PublicOccurrenceReason | null;
}

/** NIHO's PublicExperienceAvailabilityResponse. */
export interface PublicAvailability {
  readonly generatedAt: string;
  readonly timeZone: "Asia/Tokyo";
  readonly windowDays: number;
  readonly occurrences: readonly PublicOccurrence[];
}

/** NIHO's PublicExperienceCheckoutAnswer: text for text questions, optionIds for select questions. */
export interface GuestBookingAnswer {
  readonly questionId: string;
  readonly text?: string;
  readonly optionIds?: readonly string[];
}

export interface GuestBookingUtm {
  readonly utmSource?: string;
  readonly utmMedium?: string;
  readonly utmCampaign?: string;
  readonly utmContent?: string;
}

/** NIHO's checkout request plus what the web layer adds (the current consent version, the guest's language). */
export interface StartGuestBookingInput {
  readonly slug: string;
  readonly offerId: string;
  /** Asia/Tokyo YYYY-MM-DD of the occurrence, as availability lists it. */
  readonly occurrenceDate: string;
  readonly adultCount: number;
  readonly childCount: number;
  readonly expectedTotalYen: number;
  readonly bookingQuestionsFingerprint: string;
  readonly answers?: readonly GuestBookingAnswer[];
  /** consent.agreedVersion of the request. */
  readonly termsConsentVersion: string;
  /** The terms version the site shows now (web configuration). */
  readonly currentConsentVersion: string;
  /** conditionsConsent.version of the request. */
  readonly conditionsConsentVersion?: string | null;
  readonly guestName: string;
  readonly guestEmail: string;
  readonly guestPhone?: string | null;
  readonly guestLanguage: "EN" | "JA";
  readonly note?: string | null;
  /** Leave out when the browser sends DNT: 1. */
  readonly utm?: GuestBookingUtm;
  readonly clientRequestKey: string;
  /** Defaults to the repository's (35 minutes); 60-3600. */
  readonly holdSeconds?: number;
}

/** A new hold, or the earlier booking of the same request. */
export interface GuestBookingStart {
  readonly publicBookingId: string;
  readonly status: BookingStatus;
  readonly holdExpiresAt: string;
  readonly totalAmount: number;
  readonly currency: string;
  readonly stripeConnectAccountRef: string;
  readonly sellerDisplayName: string;
  readonly productTitle: string;
  /** null once the guest data was erased. */
  readonly guestEmail: string | null;
  /** The Checkout Session already attached to this booking (a repeated request), or null. */
  readonly checkoutSessionRef: string | null;
  /** For experience-payments' createDirectCheckout. */
  readonly booking: BookingRecord;
}

/** A guest's Stripe Checkout Session that ended unpaid: experience-payments' VerifiedDirectCheckoutEndedEvent. */
export interface ReleaseGuestHoldInput {
  readonly publicBookingId: string;
  /** The Session the event is about. */
  readonly checkoutSessionRef: string;
  /** The Stripe Connect account on the verified webhook envelope. */
  readonly connectedAccountId: string;
  readonly stripeEventId: string;
  readonly stripeEventType: "checkout.session.expired" | "checkout.session.async_payment_failed";
  readonly eventOccurredAtUtc: string;
}

export interface GuestHoldRelease {
  /** The booking's status after the event. */
  readonly status: BookingStatus;
  /** This event gave the seats back (HOLD became EXPIRED). */
  readonly released: boolean;
  /** The event was recorded before; nothing changed. */
  readonly duplicateEvent: boolean;
}

type Queryable = Pool | PoolClient;
type InputType = BookingQuestionInputType;

const INPUT_TYPES: ReadonlySet<string> = new Set(["SHORT_TEXT", "LONG_TEXT", "SINGLE_SELECT", "MULTI_SELECT"]);
const CANCELLATION_POLICIES: ReadonlySet<string> = new Set(["FREE_UNTIL_24H", "FREE_UNTIL_48H", "NONE"]);
const UTM_KEYS = ["utmSource", "utmMedium", "utmCampaign", "utmContent"] as const;
const PUBLIC_ID = /^[A-Za-z0-9_-]{1,40}$/;
const OFFER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const REQUEST_KEY = /^[A-Za-z0-9._:-]{8,120}$/;
const UTM_VALUE = /^[a-z0-9_-]{1,64}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+?[0-9 ().-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_REF = /^[A-Za-z0-9_-]{1,256}$/;
const ENDED_SESSION_EVENTS: ReadonlySet<string> = new Set(["checkout.session.expired", "checkout.session.async_payment_failed"]);
/** Control characters other than tab and line breaks. */
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const ANY_CONTROL = /[\u0000-\u001F\u007F]/;
const WEEKDAY_NUMBER: Readonly<Record<Weekday, number>> = {
  SUNDAY: 0, MONDAY: 1, TUESDAY: 2, WEDNESDAY: 3, THURSDAY: 4, FRIDAY: 5, SATURDAY: 6,
};
/** bookings.idempotency_key holds 256 characters: "guest-checkout:" + product id + ":" + a 120-character key. */
const MAX_SELLABLE_PRODUCT_ID_LENGTH = 120;
const MAX_LISTED_OCCURRENCES = 2_000;
/** sellableSlugs answers for one page of cards. */
const MAX_SELLABLE_SLUGS_ASKED = 200;

const SALE_SETTINGS_COLUMNS = "provider_id, support_enabled, platform_fee_basis_points, version, updated_at";
const TERMS_COLUMNS = `
  provider_id, product_id, child_price_amount, child_min_age, child_max_age, child_adult_required,
  minimum_participants, max_party_size, cancellation_policy, booking_questions,
  booking_questions_fingerprint, conditions_version, version, updated_at`;

/* ---------- sale terms ---------- */

function plainText(value: unknown, path: string, max: number): string {
  if (typeof value !== "string" || ANY_CONTROL.test(value)) throw new StoreValidationError(`${path} must be one line of text.`);
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > max) throw new StoreValidationError(`${path} must contain 1-${max} characters.`);
  return trimmed;
}

function integerIn(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new StoreValidationError(`${path} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

function validQuestions(value: unknown): BookingQuestion[] {
  if (!Array.isArray(value) || value.length > GUEST_BOOKING_LIMITS.bookingQuestions) {
    throw new StoreValidationError(`bookingQuestions must be an array of at most ${GUEST_BOOKING_LIMITS.bookingQuestions}.`);
  }
  const ids = new Set<string>();
  return value.map((raw: unknown, index): BookingQuestion => {
    const path = `bookingQuestions.${index}`;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new StoreValidationError(`${path} must be an object.`);
    const question = raw as Record<string, unknown>;
    if (typeof question.id !== "string" || !PUBLIC_ID.test(question.id) || ids.has(question.id)) {
      throw new StoreValidationError(`${path}.id must be a unique 1-40 character id of letters, digits, _ or -.`);
    }
    ids.add(question.id);
    if (typeof question.inputType !== "string" || !INPUT_TYPES.has(question.inputType)) throw new StoreValidationError(`${path}.inputType is invalid.`);
    if (typeof question.required !== "boolean") throw new StoreValidationError(`${path}.required must be a boolean.`);
    const inputType = question.inputType as InputType;
    const select = inputType === "SINGLE_SELECT" || inputType === "MULTI_SELECT";
    const options = question.options;
    if (!Array.isArray(options)
      || (select ? options.length < GUEST_BOOKING_LIMITS.questionOptionsMin || options.length > GUEST_BOOKING_LIMITS.questionOptionsMax : options.length !== 0)) {
      throw new StoreValidationError(`${path}.options must be empty for text and 2-8 for select questions.`);
    }
    const optionIds = new Set<string>();
    return {
      id: question.id,
      prompt: plainText(question.prompt, `${path}.prompt`, 120),
      description: question.description === null || question.description === undefined ? null : plainText(question.description, `${path}.description`, 300),
      inputType,
      required: question.required,
      options: options.map((option: unknown, optionIndex) => {
        const optionPath = `${path}.options.${optionIndex}`;
        if (option === null || typeof option !== "object" || Array.isArray(option)) throw new StoreValidationError(`${optionPath} must be an object.`);
        const { id, label } = option as Record<string, unknown>;
        if (typeof id !== "string" || !PUBLIC_ID.test(id) || optionIds.has(id)) throw new StoreValidationError(`${optionPath}.id must be a unique id.`);
        optionIds.add(id);
        return { id, label: plainText(label, `${optionPath}.label`, 80) };
      }),
    };
  });
}

/** NIHO's computation (packages/api-client/test/contract.test.ts): SHA-256 of the canonical questions JSON. */
function questionsFingerprint(questions: readonly BookingQuestion[]): string {
  const canonical = questions.map((question) => ({
    id: question.id,
    prompt: question.prompt,
    description: question.description,
    inputType: question.inputType,
    required: question.required,
    options: question.options.map((option) => ({ id: option.id, label: option.label })),
  }));
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

function validSaleTerms(input: ProductSaleTermsInput): ProductSaleTermsInput {
  if (input === null || typeof input !== "object") throw new StoreValidationError("terms must be an object.");
  let childPricing: ChildPricing | null = null;
  if (input.childPricing !== null) {
    const child = input.childPricing;
    if (child === undefined || typeof child !== "object") throw new StoreValidationError("childPricing must be an object or null.");
    assertMoney(child.priceYen, "childPricing.priceYen");
    const minAge = integerIn(child.minAge, "childPricing.minAge", 0, 17);
    const maxAge = integerIn(child.maxAge, "childPricing.maxAge", minAge, 17);
    if (typeof child.adultRequired !== "boolean") throw new StoreValidationError("childPricing.adultRequired must be a boolean.");
    // A party of children only pays the child price alone, which must still be a chargeable amount.
    if (!child.adultRequired && child.priceYen < GUEST_BOOKING_LIMITS.minimumChargeYen) {
      throw new StoreValidationError(`childPricing.priceYen must be at least ${GUEST_BOOKING_LIMITS.minimumChargeYen} when children may book without an adult.`);
    }
    childPricing = { priceYen: child.priceYen, minAge, maxAge, adultRequired: child.adultRequired };
  }
  const minimumParticipants = integerIn(input.minimumParticipants, "minimumParticipants", 1, GUEST_BOOKING_LIMITS.maxPartySize);
  const maxPartySize = integerIn(input.maxPartySize, "maxPartySize", minimumParticipants, GUEST_BOOKING_LIMITS.maxPartySize);
  if (typeof input.cancellationPolicy !== "string" || !CANCELLATION_POLICIES.has(input.cancellationPolicy)) {
    throw new StoreValidationError("cancellationPolicy is invalid.");
  }
  if (input.conditionsVersion !== null && (typeof input.conditionsVersion !== "string" || !SHA256_HEX.test(input.conditionsVersion))) {
    throw new StoreValidationError("conditionsVersion must be null or a lowercase SHA-256 hex digest.");
  }
  return {
    childPricing,
    minimumParticipants,
    maxPartySize,
    cancellationPolicy: input.cancellationPolicy,
    bookingQuestions: validQuestions(input.bookingQuestions),
    conditionsVersion: input.conditionsVersion,
  };
}

function termsFromRow(row: DbRow): ProductSaleTerms {
  return {
    providerId: String(row.provider_id),
    productId: String(row.product_id),
    childPricing: row.child_price_amount === null ? null : {
      priceYen: Number(row.child_price_amount),
      minAge: Number(row.child_min_age),
      maxAge: Number(row.child_max_age),
      adultRequired: row.child_adult_required === true,
    },
    minimumParticipants: Number(row.minimum_participants),
    maxPartySize: Number(row.max_party_size),
    cancellationPolicy: String(row.cancellation_policy) as GuestCancellationPolicy,
    bookingQuestions: validQuestions(row.booking_questions),
    bookingQuestionsFingerprint: String(row.booking_questions_fingerprint),
    conditionsVersion: row.conditions_version === null ? null : String(row.conditions_version),
    version: Number(row.version),
    updatedAtUtc: isoValue(row, "updated_at"),
  };
}

function saleSettingsFromRow(row: DbRow): ProviderSaleSettings {
  return {
    providerId: String(row.provider_id),
    supportEnabled: row.support_enabled === true,
    platformFeeBasisPoints: Number(row.platform_fee_basis_points) === PLATFORM_FEE_BASIS_POINTS.supportOn
      ? PLATFORM_FEE_BASIS_POINTS.supportOn
      : PLATFORM_FEE_BASIS_POINTS.supportOff,
    version: Number(row.version),
    updatedAtUtc: isoValue(row, "updated_at"),
  };
}

/* ---------- what is for sale ---------- */

interface Sellable {
  readonly product: ProductRecord;
  readonly terms: ProductSaleTerms;
  readonly settings: ProviderSaleSettings;
}

/**
 * The product travelers may book under this slug: exactly one PUBLISHED product across providers has it
 * (as guide links and guest questions), it has sale terms, its provider has sale settings (no fee is
 * ever assumed), it is sold in JPY at a chargeable price whose fee Stripe accepts, and its ID fits the
 * guest idempotency key. Anything else is not for sale (fail closed).
 */
async function loadSellable(client: Queryable, slug: string, lock: boolean): Promise<Sellable | null> {
  if (typeof slug !== "string" || slug.length < 1 || slug.length > 160) return null;
  const products = await client.query<DbRow>(
    `SELECT ${PRODUCT_COLUMNS} FROM experience_products WHERE slug=$1 AND status='PUBLISHED'
      ORDER BY provider_id, id LIMIT 2${lock ? " FOR SHARE" : ""}`,
    [slug],
  );
  if (products.rows.length !== 1) return null;
  const product = productFromRow(products.rows[0]!);
  if (!sellableProduct(product)) return null;
  const terms = await client.query<DbRow>(
    `SELECT ${TERMS_COLUMNS} FROM experience_product_sale_terms WHERE provider_id=$1 AND product_id=$2${lock ? " FOR SHARE" : ""}`,
    [product.providerId, product.id],
  );
  if (terms.rows[0] === undefined) return null;
  const settings = await client.query<DbRow>(
    `SELECT ${SALE_SETTINGS_COLUMNS} FROM provider_sale_settings WHERE provider_id=$1${lock ? " FOR SHARE" : ""}`,
    [product.providerId],
  );
  if (settings.rows[0] === undefined) return null;
  const sellable = { product, terms: termsFromRow(terms.rows[0]), settings: saleSettingsFromRow(settings.rows[0]) };
  return chargeableFee(product.unitAmount, sellable.terms.childPricing, sellable.settings.platformFeeBasisPoints) ? sellable : null;
}

/** A JPY price Stripe can charge, and an ID that fits the guest idempotency key (loadSellable, sellableSlugs). */
function sellableProduct(product: Pick<ProductRecord, "id" | "currency" | "unitAmount">): boolean {
  return product.currency === "JPY" && product.unitAmount >= GUEST_BOOKING_LIMITS.minimumChargeYen
    && product.id.length <= MAX_SELLABLE_PRODUCT_ID_LENGTH;
}

/**
 * NIHO's fee on the smallest total a party may pay (one adult, or one child where children may come alone)
 * is one that Stripe accepts.
 */
function chargeableFee(unitAmount: number, child: ChildPricing | null, basisPoints: number): boolean {
  const smallest = child !== null && !child.adultRequired ? Math.min(unitAmount, child.priceYen) : unitAmount;
  return chargeablePlatformFee(smallest, basisPoints);
}

async function databaseNow(client: Queryable): Promise<string> {
  const result = await client.query<DbRow>("SELECT clock_timestamp() AS now");
  return isoValue(result.rows[0]!, "now");
}

function tokyoDate(utc: string): string {
  return new Date(Date.parse(utc) + 9 * 60 * 60 * 1_000).toISOString().slice(0, 10);
}

/** A public offer is a schedule rule that has not ended and whose ID is a valid public offer ID. */
async function activeRules(client: Queryable, providerId: string, productId: string, today: string): Promise<StoredScheduleRule[]> {
  const result = await client.query<DbRow>(
    `SELECT ${RULE_COLUMNS} FROM schedule_rules
      WHERE provider_id=$1 AND product_id=$2 AND (
        ends_on IS NULL OR ends_on >= $3::date
        -- An ended rule still sells an occurrence the host moved to today or later.
        OR EXISTS (SELECT 1 FROM schedule_occurrence_overrides o
                    WHERE o.provider_id=schedule_rules.provider_id AND o.rule_id=schedule_rules.id
                      AND o.kind='RESCHEDULE' AND o.local_date >= $3::date))
      ORDER BY local_start_time, id COLLATE "C"`,
    [providerId, productId, today],
  );
  return result.rows.map(scheduleRuleFromRow).filter((stored) => OFFER_ID.test(stored.rule.id));
}

function weekdaysOf(rule: ScheduleRule): number[] {
  switch (rule.recurrence.kind) {
    case "DAILY":
      return [0, 1, 2, 3, 4, 5, 6];
    case "WEEKLY":
      return [WEEKDAY_NUMBER[weekdayOf(rule.startsOn)]];
    case "WEEKENDS":
      return [0, 6];
    case "SELECTED_WEEKDAYS":
      return [...new Set(rule.recurrence.weekdays.map((weekday) => WEEKDAY_NUMBER[weekday]))].sort((a, b) => a - b);
  }
}

/** The public offer name is at most 80 characters (PublicExperienceOffer.name). */
function offerName(title: string): string {
  const characters = [...title];
  return characters.length <= 80 ? title : `${characters.slice(0, 79).join("")}…`;
}

function offerFor(sellable: Sellable, stored: StoredScheduleRule): PublicBookingOffer {
  const { product, terms } = sellable;
  const rule = stored.rule;
  return {
    id: rule.id,
    name: offerName(product.publicTitle),
    shortDescription: null,
    pricing: { currency: "JPY", taxIncluded: true, adultPriceYen: product.unitAmount, child: terms.childPricing },
    capacity: rule.capacity,
    maxPartySize: terms.maxPartySize,
    minimumParticipants: terms.minimumParticipants,
    durationMinutes: rule.durationMinutes,
    startTime: rule.localStartTime,
    weekdays: weekdaysOf(rule),
    cancellationPolicy: {
      code: terms.cancellationPolicy,
      freeCancellationHoursBefore: terms.cancellationPolicy === "FREE_UNTIL_24H" ? 24 : terms.cancellationPolicy === "FREE_UNTIL_48H" ? 48 : null,
    },
    acceptanceMode: "INSTANT",
    bookingQuestions: terms.bookingQuestions,
    bookingQuestionsFingerprint: terms.bookingQuestionsFingerprint,
  };
}

/** The same expansion as the host calendar: every stored override (moves, legacy CLOSE) and sales state. */
async function expandRules(
  client: Queryable,
  providerId: string,
  rules: readonly StoredScheduleRule[],
  fromDate: string,
  toDate: string,
): Promise<{ readonly ruleId: string; readonly occurrence: Occurrence }[]> {
  if (rules.length === 0) return [];
  const ruleIds = rules.map((stored) => stored.rule.id);
  const overrides = await client.query<DbRow>(
    `SELECT rule_id, ${OVERRIDE_COLUMNS} FROM schedule_occurrence_overrides WHERE provider_id=$1 AND rule_id=ANY($2::text[])`,
    [providerId, ruleIds],
  );
  const salesStates = await client.query<DbRow>(
    `SELECT rule_id, ${SALES_STATE_COLUMNS} FROM schedule_occurrence_sales_states WHERE provider_id=$1 AND rule_id=ANY($2::text[])`,
    [providerId, ruleIds],
  );
  const overridesByRule = new Map<string, OccurrenceOverride[]>();
  for (const row of overrides.rows) {
    const ruleId = String(row.rule_id);
    overridesByRule.set(ruleId, [...(overridesByRule.get(ruleId) ?? []), overrideFromRow(row).override]);
  }
  const salesStatesByRule = new Map<string, OccurrenceSalesState[]>();
  for (const row of salesStates.rows) {
    const ruleId = String(row.rule_id);
    salesStatesByRule.set(ruleId, [...(salesStatesByRule.get(ruleId) ?? []), salesStateFromRow(row).state]);
  }
  return rules.flatMap((stored) => expandOccurrences({
    rule: stored.rule,
    overrides: overridesByRule.get(stored.rule.id) ?? [],
    salesStates: salesStatesByRule.get(stored.rule.id) ?? [],
    fromDate,
    toDate,
  }).map((occurrence) => ({ ruleId: stored.rule.id, occurrence })));
}

/** The three public reasons. Seats first: a full occurrence reads FULL whatever else holds it. */
function publicReason(reason: AvailabilityReason): PublicOccurrenceReason | null {
  switch (reason) {
    case "AVAILABLE":
      return null;
    case "BOOKING_CUTOFF_REACHED":
      return "CUTOFF";
    case "INSUFFICIENT_CAPACITY":
    case "GROUP_RESERVED":
      return "FULL";
    default:
      return "UNAVAILABLE";
  }
}

/**
 * Why a hold was refused, as NIHO's checkout says it. The host's own stop or a conflict on this
 * occurrence is OCCURRENCE_INVALID (choose another); a stale sync, an inactive resource or an
 * unresolved external reservation stops the whole experience for now: UNAVAILABLE.
 */
function checkoutErrorFor(error: BookingUnavailableError): GuestCheckoutError {
  switch (error.reason as AvailabilityReason) {
    case "BOOKING_CUTOFF_REACHED":
      return new GuestCheckoutError("OCCURRENCE_INVALID", { occurrenceReason: "CUTOFF" });
    case "INSUFFICIENT_CAPACITY":
      return new GuestCheckoutError("FULL", { seatsLeft: error.availableSeats });
    case "GROUP_RESERVED":
      return new GuestCheckoutError("FULL", { seatsLeft: 0 });
    case "MANUALLY_CLOSED":
    case "RESOURCE_BUSY":
    case "RESOURCE_GOOGLE_BUSY":
    case "GOOGLE_BUSY":
      return new GuestCheckoutError("OCCURRENCE_INVALID", { occurrenceReason: "UNAVAILABLE" });
    default:
      return new GuestCheckoutError("UNAVAILABLE");
  }
}

/* ---------- the guest's request ---------- */

interface ValidAnswer {
  readonly questionId: string;
  readonly text?: string;
  readonly optionIds?: readonly string[];
}

interface ValidRequest {
  readonly slug: string;
  readonly offerId: string;
  readonly occurrenceDate: string;
  readonly adultCount: number;
  readonly childCount: number;
  readonly expectedTotalYen: number;
  readonly bookingQuestionsFingerprint: string;
  readonly answers: readonly ValidAnswer[];
  readonly termsConsentVersion: string;
  readonly currentConsentVersion: string;
  readonly conditionsConsentVersion: string | null;
  readonly guestName: string;
  readonly guestEmail: string;
  readonly guestPhone: string | null;
  readonly guestLanguage: "EN" | "JA";
  readonly note: string | null;
  readonly utm: Readonly<Record<string, string>>;
  readonly clientRequestKey: string;
  readonly holdSeconds: number;
  /** SHA-256 of everything the guest sent, for REQUEST_MISMATCH. */
  readonly fingerprint: string;
}

function invalid(field: string): GuestCheckoutError {
  return new GuestCheckoutError("INPUT_INVALID", { field });
}

function count(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > GUEST_BOOKING_LIMITS.maxPartySize) throw invalid(field);
  return value;
}

/** As normalizeGuestPhone/isValidGuestPhone in packages/api-client/src/journey.ts (NIHO's rule). */
function guestPhone(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw invalid("guestPhone");
  const text = value.trim().replace(/\s+/g, " ");
  const digits = text.replace(/[^0-9]/g, "").length;
  if (text.length === 0 || text.length > GUEST_BOOKING_LIMITS.phoneMaxLength || !PHONE.test(text)
    || digits < GUEST_BOOKING_LIMITS.phoneMinDigits || digits > GUEST_BOOKING_LIMITS.phoneMaxDigits) throw invalid("guestPhone");
  return text;
}

function answerShapes(value: unknown): ValidAnswer[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > GUEST_BOOKING_LIMITS.bookingQuestions) {
    throw new GuestCheckoutError("ANSWERS_INVALID", { field: "answers" });
  }
  return value.map((raw: unknown): ValidAnswer => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new GuestCheckoutError("ANSWERS_INVALID", { field: "questionId" });
    const answer = raw as Record<string, unknown>;
    if (typeof answer.questionId !== "string" || !PUBLIC_ID.test(answer.questionId)) {
      throw new GuestCheckoutError("ANSWERS_INVALID", { field: "questionId" });
    }
    const questionId = answer.questionId;
    const hasText = answer.text !== undefined;
    const hasOptions = answer.optionIds !== undefined;
    if (hasText && hasOptions) throw new GuestCheckoutError("ANSWERS_INVALID", { questionId, field: "answer" });
    if (hasText) {
      if (typeof answer.text !== "string" || CONTROL.test(answer.text) || answer.text.length > GUEST_BOOKING_LIMITS.longTextAnswerMaxLength) {
        throw new GuestCheckoutError("ANSWERS_INVALID", { questionId, field: "text" });
      }
      return { questionId, text: answer.text.trim() };
    }
    if (hasOptions) {
      const optionIds = answer.optionIds;
      if (!Array.isArray(optionIds) || optionIds.length > GUEST_BOOKING_LIMITS.questionOptionsMax
        || !optionIds.every((id: unknown) => typeof id === "string" && PUBLIC_ID.test(id))) {
        throw new GuestCheckoutError("ANSWERS_INVALID", { questionId, field: "optionIds" });
      }
      return { questionId, optionIds: [...(optionIds as string[])] };
    }
    return { questionId };
  });
}

/**
 * Checks everything that needs no database, in the order NIHO's checkout does. A guest's field answers
 * INPUT_INVALID with that field's name in the public request; the web layer's own values
 * (currentConsentVersion, holdSeconds) answer StoreValidationError.
 */
function validRequest(input: StartGuestBookingInput, defaultHoldSeconds: number): ValidRequest {
  if (input === null || typeof input !== "object") throw new StoreValidationError("request must be an object.");
  if (typeof input.currentConsentVersion !== "string" || input.currentConsentVersion.length < 1 || input.currentConsentVersion.length > 100) {
    throw new StoreValidationError("currentConsentVersion must contain 1-100 characters.");
  }
  const holdSeconds = input.holdSeconds ?? defaultHoldSeconds;
  if (!Number.isInteger(holdSeconds) || holdSeconds < 60 || holdSeconds > 3_600) throw new StoreValidationError("holdSeconds must be between 60 and 3600.");

  if (input.conditionsConsentVersion !== undefined && input.conditionsConsentVersion !== null
    && (typeof input.conditionsConsentVersion !== "string" || input.conditionsConsentVersion.length < 1 || input.conditionsConsentVersion.length > 100)) {
    throw invalid("conditionsConsent");
  }
  const phone = guestPhone(input.guestPhone);
  if (typeof input.clientRequestKey !== "string" || !REQUEST_KEY.test(input.clientRequestKey)) throw invalid("clientRequestKey");
  // A name is one line: runs of spaces and line breaks become one space.
  const name = typeof input.guestName === "string" ? input.guestName.replace(/\s+/g, " ").trim() : "";
  if (name.length < 1 || name.length > GUEST_BOOKING_LIMITS.guestNameMaxLength || ANY_CONTROL.test(name)) throw invalid("guestName");
  const email = typeof input.guestEmail === "string" ? input.guestEmail.trim() : "";
  if (email.length < 3 || email.length > GUEST_BOOKING_LIMITS.guestEmailMaxLength || !EMAIL.test(email) || ANY_CONTROL.test(email)) throw invalid("guestEmail");
  let note: string | null = null;
  if (input.note !== undefined && input.note !== null) {
    if (typeof input.note !== "string" || input.note.length > GUEST_BOOKING_LIMITS.noteMaxLength || CONTROL.test(input.note)) throw invalid("note");
    note = input.note.trim() === "" ? null : input.note.trim();
  }
  const utm: Record<string, string> = {};
  if (input.utm !== undefined && (input.utm === null || typeof input.utm !== "object")) throw invalid("utmSource");
  for (const key of UTM_KEYS) {
    const value = input.utm?.[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || !UTM_VALUE.test(value)) throw invalid(key);
    utm[key] = value;
  }
  const adultCount = count(input.adultCount, "adultCount");
  const childCount = count(input.childCount, "childCount");
  if (typeof input.offerId !== "string" || !OFFER_ID.test(input.offerId)) throw invalid("offerId");
  if (typeof input.occurrenceDate !== "string" || !LOCAL_DATE.test(input.occurrenceDate)) throw invalid("occurrenceDate");
  try {
    assertLocalDate(input.occurrenceDate, "occurrenceDate");
  } catch {
    throw invalid("occurrenceDate");
  }
  if (typeof input.expectedTotalYen !== "number" || !Number.isSafeInteger(input.expectedTotalYen) || input.expectedTotalYen < 0) {
    throw invalid("expectedTotalYen");
  }
  if (typeof input.bookingQuestionsFingerprint !== "string" || input.bookingQuestionsFingerprint.length < 1 || input.bookingQuestionsFingerprint.length > 128) {
    throw invalid("bookingQuestionsFingerprint");
  }
  if (typeof input.termsConsentVersion !== "string" || input.termsConsentVersion.length < 1 || input.termsConsentVersion.length > 100) {
    throw invalid("consent.agreedVersion");
  }
  if (input.guestLanguage !== "EN" && input.guestLanguage !== "JA") throw invalid("guestLanguage");
  const answers = answerShapes(input.answers);

  const request = {
    offerId: input.offerId,
    occurrenceDate: input.occurrenceDate,
    adultCount,
    childCount,
    expectedTotalYen: input.expectedTotalYen,
    bookingQuestionsFingerprint: input.bookingQuestionsFingerprint,
    answers,
    termsConsentVersion: input.termsConsentVersion,
    conditionsConsentVersion: input.conditionsConsentVersion ?? null,
    guestName: name,
    guestEmail: email,
    guestPhone: phone,
    guestLanguage: input.guestLanguage,
    note,
    utm,
  };
  const fingerprint = createHash("sha256").update(JSON.stringify([
    request.offerId, request.occurrenceDate, request.adultCount, request.childCount, request.expectedTotalYen,
    request.bookingQuestionsFingerprint, request.answers, request.termsConsentVersion, request.conditionsConsentVersion,
    request.guestName, request.guestEmail, request.guestPhone, request.guestLanguage, request.note,
    UTM_KEYS.map((key) => utm[key] ?? null),
  ]), "utf8").digest("hex");
  return { ...request, slug: input.slug, currentConsentVersion: input.currentConsentVersion, clientRequestKey: input.clientRequestKey, holdSeconds, fingerprint };
}

/** Answers against the offer's questions. Returns what is kept: answered questions only. */
function checkedAnswers(questions: readonly BookingQuestion[], answers: readonly ValidAnswer[]): ValidAnswer[] {
  const byId = new Map(questions.map((question) => [question.id, question]));
  const seen = new Set<string>();
  const kept: ValidAnswer[] = [];
  for (const answer of answers) {
    const question = byId.get(answer.questionId);
    if (question === undefined || seen.has(answer.questionId)) throw new GuestCheckoutError("ANSWERS_INVALID", { questionId: answer.questionId, field: "questionId" });
    seen.add(answer.questionId);
    if (question.inputType === "SHORT_TEXT" || question.inputType === "LONG_TEXT") {
      if (answer.optionIds !== undefined) throw new GuestCheckoutError("ANSWERS_INVALID", { questionId: question.id, field: "optionIds" });
      const max = question.inputType === "SHORT_TEXT" ? GUEST_BOOKING_LIMITS.shortTextAnswerMaxLength : GUEST_BOOKING_LIMITS.longTextAnswerMaxLength;
      if (answer.text !== undefined && answer.text.length > max) throw new GuestCheckoutError("ANSWERS_INVALID", { questionId: question.id, field: "text" });
      if (answer.text !== undefined && answer.text.length > 0) kept.push({ questionId: question.id, text: answer.text });
      continue;
    }
    if (answer.text !== undefined) throw new GuestCheckoutError("ANSWERS_INVALID", { questionId: question.id, field: "text" });
    if (answer.optionIds === undefined) continue;
    const optionIds = answer.optionIds;
    const known = new Set(question.options.map((option) => option.id));
    const exactly = question.inputType === "SINGLE_SELECT" ? 1 : optionIds.length;
    if (optionIds.length !== exactly || new Set(optionIds).size !== optionIds.length || !optionIds.every((id) => known.has(id))) {
      throw new GuestCheckoutError("ANSWERS_INVALID", { questionId: question.id, field: "optionIds" });
    }
    if (optionIds.length > 0) kept.push({ questionId: question.id, optionIds: [...optionIds] });
  }
  // As NIHO: a required question left unanswered means the form the guest saw is not the current one.
  for (const question of questions) {
    if (question.required && !kept.some((answer) => answer.questionId === question.id)) {
      throw new GuestCheckoutError("QUESTIONS_CHANGED", { questionId: question.id });
    }
  }
  return kept;
}

function startResult(booking: BookingRecord, productTitle: string, guestEmail: string | null, checkoutSessionRef: string | null): GuestBookingStart {
  return {
    publicBookingId: booking.publicBookingId,
    status: booking.status,
    holdExpiresAt: booking.holdExpiresAtUtc,
    totalAmount: booking.pricingSnapshot.totalAmount,
    currency: booking.pricingSnapshot.currency,
    stripeConnectAccountRef: booking.sellerSnapshot.stripeConnectAccountRef,
    sellerDisplayName: booking.sellerSnapshot.displayName,
    productTitle,
    guestEmail,
    checkoutSessionRef,
    booking,
  };
}

/**
 * 旅行者の予約 (#285; migrations 0023 and 0025). The traveler's booking flow on this site, backed by the same
 * occurrence expansion, stored-inventory evaluation and hold transaction as the host calendar and
 * ExperienceStore.createBookingHold. The public methods take a slug or a booking ID and no identity;
 * the web layer establishes nothing else. Results map 1:1 onto NIHO's public contract (offers,
 * availability, checkout errors). Names, addresses, phones, notes and answers stay in booking_guests:
 * never in outbox payloads, logs or error messages. The host's methods take a HostActor; what 予約 reads
 * (host-guest-bookings.ts) carries the guest's name, phone, note and answers to their OWNER, never the address.
 */
export class GuestBookingRepository {
  readonly #pool: Pool;
  readonly #defaultHoldSeconds: number;

  constructor(pool: Pool, options: { readonly defaultHoldSeconds?: number } = {}) {
    this.#pool = pool;
    this.#defaultHoldSeconds = options.defaultHoldSeconds ?? GUEST_BOOKING_LIMITS.defaultHoldSeconds;
    if (!Number.isInteger(this.#defaultHoldSeconds) || this.#defaultHoldSeconds < 60 || this.#defaultHoldSeconds > 3_600) {
      throw new StoreValidationError("defaultHoldSeconds must be between 60 and 3600.");
    }
  }

  /* ---------- the host (OWNER/EDITOR) ---------- */

  /**
   * Writes a product's sale terms: without them a product is not sold here. Without expectedVersion the
   * terms must not exist yet; with it they must be at that version. The editor (#89) wires this later.
   */
  async setSaleTerms(actor: HostActor, productId: string, rawTerms: ProductSaleTermsInput, expectedVersion?: number): Promise<ProductSaleTerms> {
    assertStoreIdentifier(productId, "productId");
    const terms = validSaleTerms(rawTerms);
    if (expectedVersion !== undefined && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)) {
      throw new StoreValidationError("expectedVersion must be a positive integer.");
    }
    const fingerprint = questionsFingerprint(terms.bookingQuestions);
    return withTransaction(this.#pool, async (client) => {
      await requireMembership(client, actor, ["OWNER", "EDITOR"]);
      const product = await client.query("SELECT 1 FROM experience_products WHERE provider_id=$1 AND id=$2 FOR SHARE", [actor.providerId, productId]);
      if (product.rows[0] === undefined) throw new StoreNotFoundError("product");
      const child = terms.childPricing;
      const values = [
        actor.providerId, productId, child?.priceYen ?? null, child?.minAge ?? null, child?.maxAge ?? null, child?.adultRequired ?? null,
        terms.minimumParticipants, terms.maxPartySize, terms.cancellationPolicy, JSON.stringify(terms.bookingQuestions),
        fingerprint, terms.conditionsVersion,
      ];
      const result = expectedVersion === undefined
        ? await client.query<DbRow>(
            `INSERT INTO experience_product_sale_terms (
               provider_id, product_id, child_price_amount, child_min_age, child_max_age, child_adult_required,
               minimum_participants, max_party_size, cancellation_policy, booking_questions,
               booking_questions_fingerprint, conditions_version
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)
             ON CONFLICT DO NOTHING
             RETURNING ${TERMS_COLUMNS}`,
            values,
          )
        : await client.query<DbRow>(
            `UPDATE experience_product_sale_terms
                SET child_price_amount=$3, child_min_age=$4, child_max_age=$5, child_adult_required=$6,
                    minimum_participants=$7, max_party_size=$8, cancellation_policy=$9, booking_questions=$10::jsonb,
                    booking_questions_fingerprint=$11, conditions_version=$12,
                    version=version+1, updated_at=clock_timestamp()
              WHERE provider_id=$1 AND product_id=$2 AND version=$13
              RETURNING ${TERMS_COLUMNS}`,
            [...values, expectedVersion],
          );
      const row = result.rows[0];
      if (row === undefined) {
        throw new StoreConflictError(expectedVersion === undefined
          ? "Sale terms already exist for this product."
          : "Sale terms version mismatch or sale terms not found in this provider.");
      }
      return termsFromRow(row);
    });
  }

  /* ---------- the host console (OWNER): 予約 (#285 slice 8) ---------- */

  /**
   * The provider's guest bookings a host sees (CONFIRMED, PAYMENT_REVIEW, CANCELLED; never a hold) for its
   * OWNER: those starting at `from` (now by default) or later, the nearest first, then the earlier ones, the
   * latest first. `cursor` is the previous page's nextCursor and keeps that page's `from`. No email address.
   */
  async listGuestBookingsForHost(actor: HostActor, options: HostGuestBookingListOptions = {}): Promise<HostGuestBookingPage> {
    const limit = listLimit(options.limit);
    const cursor = decodeBookingCursor(options.cursor);
    return withTransaction(this.#pool, async (client) => {
      await requireBookingsOwner(client, actor);
      const from = cursor?.from ?? await listBoundary(client, options.from);
      const rows: DbRow[] = [];
      if (cursor === null || cursor.segment === "UPCOMING") {
        const upcoming = await selectSegment(client, actor.providerId, "UPCOMING", from, cursor?.after ?? null, limit + 1);
        if (upcoming.length > limit) {
          const page = upcoming.slice(0, limit);
          return { bookings: page.map(hostGuestBookingFromRow), nextCursor: cursorAfter(from, "UPCOMING", page.at(-1)!) };
        }
        rows.push(...upcoming);
      }
      // The rest of the page from the past; with no room left, one row says whether a past page follows.
      const room = limit - rows.length;
      const past = await selectSegment(client, actor.providerId, "PAST", from, cursor?.segment === "PAST" ? cursor.after : null, room + 1);
      const page = past.slice(0, room);
      rows.push(...page);
      return { bookings: rows.map(hostGuestBookingFromRow), nextCursor: past.length > room ? cursorAfter(from, "PAST", page.at(-1) ?? null) : null };
    });
  }

  /** One guest booking of the provider for its OWNER. Another provider's, a hold or none is StoreNotFoundError. */
  async getGuestBookingForHost(actor: HostActor, publicBookingId: string): Promise<HostGuestBooking> {
    const id = publicBookingIdOf(publicBookingId);
    return withTransaction(this.#pool, async (client) => {
      await requireBookingsOwner(client, actor);
      return hostGuestBookingFromRow(await selectOne(client, actor.providerId, id));
    });
  }

  /** How many guest bookings listGuestBookingsForHost would list in all (予約's notice beside NIHO's bookings). */
  async countGuestBookingsForHost(actor: HostActor): Promise<number> {
    return withTransaction(this.#pool, async (client) => {
      await requireBookingsOwner(client, actor);
      return countShown(client, actor.providerId);
    });
  }

  /* ---------- the host console (OWNER): ホーム and この回 (#285 slice 8b) ---------- */

  /**
   * ホーム's 今日・明日・これからの開催 for the provider's OWNER: the sessions with guests from this site starting
   * at `from` (now by default) or later and before `to`, the nearest first, with how many may come. Confirmed
   * bookings and payments under review count; cancellations and holds never do. A session is what the bookings'
   * occurrence snapshots name (HostGuestSession), as 予約 groups them. No guest's name or contact.
   */
  async listGuestSessionsForHost(actor: HostActor, options: HostGuestSessionListOptions = {}): Promise<HostGuestSession[]> {
    const limit = listLimit(options.limit);
    const to = sessionWindowEnd(options.to);
    return withTransaction(this.#pool, async (client) => {
      await requireBookingsOwner(client, actor);
      const from = await listBoundary(client, options.from);
      assertSessionWindow(from, to);
      return (await selectSessions(client, actor.providerId, from, to, limit)).map(hostGuestSessionFromRow);
    });
  }

  /**
   * この回 for the provider's OWNER: the bookings made here for one session (CONFIRMED, PAYMENT_REVIEW, CANCELLED;
   * never a hold), in the order they were made, with the phone the guest gave: この回 is the one screen that shows
   * it. None for a session without bookings here, or another provider's. No email address.
   */
  async listGuestBookingsForSession(actor: HostActor, session: HostGuestSessionKey): Promise<HostGuestBooking[]> {
    const key = sessionKeyOf(session);
    return withTransaction(this.#pool, async (client) => {
      await requireBookingsOwner(client, actor);
      return (await selectSessionBookings(client, actor.providerId, key)).map(hostGuestBookingFromRow);
    });
  }

  /* ---------- NIHO staff (server-side import / Admin) ---------- */

  /**
   * Writes what NIHO charges a provider on bookings made here: 10 % with support off, 15 % with it on
   * (migration 0025). Without these settings none of the provider's products is sold here. Only NIHO's
   * server-side import or Admin may call this, never a host route: it takes no actor because the
   * provider's own members must not set NIHO's fee. Nothing in apps/web reaches it yet (the migration,
   * #285 slice 9, writes it). Without expectedVersion the settings must not exist yet; with it
   * they must be at that version. Later bookings take the new fee; bookings already made keep theirs.
   */
  async setProviderSaleSettings(
    providerId: string,
    input: { readonly supportEnabled: boolean },
    expectedVersion?: number,
  ): Promise<ProviderSaleSettings> {
    assertStoreIdentifier(providerId, "providerId");
    if (input === null || typeof input !== "object" || typeof input.supportEnabled !== "boolean") {
      throw new StoreValidationError("supportEnabled must be a boolean.");
    }
    if (expectedVersion !== undefined && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)) {
      throw new StoreValidationError("expectedVersion must be a positive integer.");
    }
    const basisPoints = input.supportEnabled ? PLATFORM_FEE_BASIS_POINTS.supportOn : PLATFORM_FEE_BASIS_POINTS.supportOff;
    return withTransaction(this.#pool, async (client) => {
      const provider = await client.query("SELECT 1 FROM experience_providers WHERE id=$1", [providerId]);
      if (provider.rows[0] === undefined) throw new StoreNotFoundError("provider");
      const result = expectedVersion === undefined
        ? await client.query<DbRow>(
            `INSERT INTO provider_sale_settings (provider_id, support_enabled, platform_fee_basis_points)
             VALUES ($1,$2,$3)
             ON CONFLICT DO NOTHING
             RETURNING ${SALE_SETTINGS_COLUMNS}`,
            [providerId, input.supportEnabled, basisPoints],
          )
        : await client.query<DbRow>(
            `UPDATE provider_sale_settings
                SET support_enabled=$2, platform_fee_basis_points=$3, version=version+1, updated_at=clock_timestamp()
              WHERE provider_id=$1 AND version=$4
              RETURNING ${SALE_SETTINGS_COLUMNS}`,
            [providerId, input.supportEnabled, basisPoints, expectedVersion],
          );
      const row = result.rows[0];
      if (row === undefined) {
        throw new StoreConflictError(expectedVersion === undefined
          ? "Sale settings already exist for this provider."
          : "Sale settings version mismatch or sale settings not found for this provider.");
      }
      return saleSettingsFromRow(row);
    });
  }

  /* ---------- the traveler (public) ---------- */

  /** The offers of the experience with this slug, or null when it is not for sale here. */
  async publicBookingTerms(slug: string): Promise<PublicBookingTerms | null> {
    const sellable = await loadSellable(this.#pool, slug, false);
    if (sellable === null) return null;
    const today = tokyoDate(await databaseNow(this.#pool));
    const rules = await activeRules(this.#pool, sellable.product.providerId, sellable.product.id, today);
    return {
      providerId: sellable.product.providerId,
      productId: sellable.product.id,
      title: sellable.product.publicTitle,
      currency: "JPY",
      sellerDisplayName: sellable.product.sellerDisplayName,
      offers: rules.map((stored) => offerFor(sellable, stored)),
      conditionsVersion: sellable.terms.conditionsVersion,
    };
  }

  /**
   * Which of these slugs are for sale here, by the rules of publicBookingTerms (exactly one PUBLISHED product
   * with the slug, its sale terms, its provider's sale settings, a chargeable JPY price and fee), read in one
   * query: a page of cards asks once for all of them. The order of `slugs` is kept; repeats are dropped.
   */
  async sellableSlugs(slugs: readonly string[]): Promise<string[]> {
    if (!Array.isArray(slugs) || slugs.length > MAX_SELLABLE_SLUGS_ASKED) {
      throw new StoreValidationError(`slugs must be an array of at most ${MAX_SELLABLE_SLUGS_ASKED}.`);
    }
    const asked = [...new Set(slugs.filter((slug) => typeof slug === "string" && slug.length >= 1 && slug.length <= 160))];
    if (asked.length === 0) return [];
    const result = await this.#pool.query<DbRow>(
      `SELECT p.slug, p.id, p.currency, p.unit_amount,
              t.product_id IS NOT NULL AS has_terms, t.child_price_amount, t.child_min_age, t.child_max_age, t.child_adult_required,
              s.platform_fee_basis_points
         FROM experience_products p
         LEFT JOIN experience_product_sale_terms t ON t.provider_id=p.provider_id AND t.product_id=p.id
         LEFT JOIN provider_sale_settings s ON s.provider_id=p.provider_id
        WHERE p.slug=ANY($1::text[]) AND p.status='PUBLISHED'`,
      [asked],
    );
    const rowsBySlug = new Map<string, DbRow[]>();
    for (const row of result.rows) rowsBySlug.set(String(row.slug), [...(rowsBySlug.get(String(row.slug)) ?? []), row]);
    return asked.filter((slug) => {
      const rows = rowsBySlug.get(slug);
      // A second published product with the slug stops the sale, as in loadSellable.
      if (rows?.length !== 1) return false;
      const row = rows[0]!;
      if (row.has_terms !== true || row.platform_fee_basis_points === null) return false;
      if (!sellableProduct({ id: String(row.id), currency: String(row.currency), unitAmount: Number(row.unit_amount) })) return false;
      const child: ChildPricing | null = row.child_price_amount === null ? null : {
        priceYen: Number(row.child_price_amount),
        minAge: Number(row.child_min_age),
        maxAge: Number(row.child_max_age),
        adultRequired: row.child_adult_required === true,
      };
      return chargeableFee(Number(row.unit_amount), child, Number(row.platform_fee_basis_points));
    });
  }

  /**
   * Seats per occurrence, counted now with the evaluation a hold uses, for a party of the minimum size.
   * The window is the Tokyo date of today through 89 days later; `fromDate`/`windowDays` only narrow it.
   * An offer with two occurrences on one date (a move onto a day it already runs) shows both as
   * UNAVAILABLE: checkout names an occurrence by offer and date only. Null when not for sale.
   */
  async listPublicAvailability(
    slug: string,
    options: { readonly fromDate?: string; readonly windowDays?: number; readonly now?: string; readonly offerId?: string } = {},
  ): Promise<PublicAvailability | null> {
    const windowDays = options.windowDays ?? GUEST_BOOKING_LIMITS.windowDays;
    if (!Number.isInteger(windowDays) || windowDays < 1 || windowDays > GUEST_BOOKING_LIMITS.windowDays) {
      throw new StoreValidationError(`windowDays must be from 1 to ${GUEST_BOOKING_LIMITS.windowDays}.`);
    }
    if (options.now !== undefined) assertCanonicalInstant(options.now, "now");
    if (options.fromDate !== undefined) {
      try {
        assertLocalDate(options.fromDate, "fromDate");
      } catch (error) {
        throw new StoreValidationError("fromDate must be a YYYY-MM-DD date.", { cause: error });
      }
    }
    if (options.offerId !== undefined && !OFFER_ID.test(options.offerId)) throw new StoreValidationError("offerId is invalid.");
    const sellable = await loadSellable(this.#pool, slug, false);
    if (sellable === null) return null;
    const { providerId, id: productId } = sellable.product;
    const nowUtc = options.now ?? await databaseNow(this.#pool);
    const today = tokyoDate(nowUtc);
    const requestedFrom = options.fromDate ?? today;
    const fromDate = requestedFrom < today ? today : requestedFrom;
    const lastPublicDate = addLocalDays(today, GUEST_BOOKING_LIMITS.windowDays - 1);
    const requestedTo = addLocalDays(requestedFrom, windowDays - 1);
    const toDate = requestedTo < lastPublicDate ? requestedTo : lastPublicDate;
    const empty: PublicAvailability = { generatedAt: nowUtc, timeZone: "Asia/Tokyo", windowDays, occurrences: [] };
    if (fromDate > toDate) return empty;

    const rules = (await activeRules(this.#pool, providerId, productId, today))
      .filter((stored) => options.offerId === undefined || stored.rule.id === options.offerId);
    const expanded = await expandRules(this.#pool, providerId, rules, fromDate, toDate);
    if (expanded.length > MAX_LISTED_OCCURRENCES) throw new StoreConflictError("Too many occurrences in the public availability window.");
    const perDate = new Map<string, number>();
    for (const { ruleId, occurrence } of expanded) {
      const key = `${ruleId}|${occurrence.localDate}`;
      perDate.set(key, (perDate.get(key) ?? 0) + 1);
    }
    const unique = expanded.filter(({ ruleId, occurrence }) => perDate.get(`${ruleId}|${occurrence.localDate}`) === 1);
    const evaluated = await evaluateStoredInventories(this.#pool, providerId, unique.map(({ occurrence }) => ({
      productId, occurrence, requestedSeats: sellable.terms.minimumParticipants,
    })), nowUtc);
    const occurrences = expanded.map(({ ruleId, occurrence }): PublicOccurrence => {
      const availability = evaluated.get(occurrence.id)?.availability;
      const reason = availability === undefined ? "UNAVAILABLE" : publicReason(availability.reason);
      return {
        offerId: ruleId,
        date: occurrence.localDate,
        startAt: occurrence.startUtc,
        endAt: occurrence.endUtc,
        bookable: reason === null,
        seatsLeft: availability?.availableSeats ?? 0,
        reason,
      };
    });
    occurrences.sort((a, b) => a.startAt.localeCompare(b.startAt) || a.offerId.localeCompare(b.offerId));
    return { ...empty, occurrences };
  }

  /**
   * Starts a booking: checks the request as NIHO's checkout does, then holds the seats and records the
   * guest in one transaction. The pricing snapshot fixes NIHO's fee from the provider's sale settings of
   * this moment (`platformFee`). The same clientRequestKey with the same content returns the earlier
   * booking (whatever its status, with the fee it was taken at); with other content REQUEST_MISMATCH.
   * Throws GuestCheckoutError with NIHO's code, StoreNotFoundError when the experience is not for sale
   * here, StoreValidationError for the web layer's own values.
   */
  async startGuestBooking(input: StartGuestBookingInput): Promise<GuestBookingStart> {
    const request = validRequest(input, this.#defaultHoldSeconds);
    const located = await loadSellable(this.#pool, request.slug, false);
    if (located === null) throw new StoreNotFoundError("experience for sale");
    const providerId = located.product.providerId;
    const productId = located.product.id;
    const idempotencyKey = `guest-checkout:${productId}:${request.clientRequestKey}`;

    return withTransaction(this.#pool, async (client) => {
      await lockProviderInventory(client, providerId);
      await lockBookingIdempotencyKey(client, providerId, idempotencyKey);
      const sellable = await loadSellable(client, request.slug, true);
      if (sellable === null || sellable.product.providerId !== providerId || sellable.product.id !== productId) {
        throw new StoreNotFoundError("experience for sale");
      }
      const { product, terms, settings } = sellable;

      const previous = await client.query<DbRow>(
        `SELECT id, ${BOOKING_COLUMNS} FROM bookings WHERE provider_id=$1 AND idempotency_key=$2`,
        [providerId, idempotencyKey],
      );
      if (previous.rows[0] !== undefined) {
        const guest = await client.query<DbRow>(
          "SELECT request_fingerprint, guest_email, checkout_session_ref FROM booking_guests WHERE provider_id=$1 AND booking_id=$2",
          [providerId, previous.rows[0].id],
        );
        const guestRow = guest.rows[0];
        if (guestRow === undefined || guestRow.request_fingerprint !== request.fingerprint) throw new GuestCheckoutError("REQUEST_MISMATCH");
        return startResult(
          bookingFromRow(previous.rows[0]),
          product.publicTitle,
          guestRow.guest_email === null ? null : String(guestRow.guest_email),
          guestRow.checkout_session_ref === null ? null : String(guestRow.checkout_session_ref),
        );
      }

      const nowUtc = await databaseNow(client);
      const today = tokyoDate(nowUtc);
      const rule = (await activeRules(client, providerId, productId, today)).find((stored) => stored.rule.id === request.offerId);
      if (rule === undefined) throw invalid("offerId");
      if (request.termsConsentVersion !== request.currentConsentVersion) {
        throw new GuestCheckoutError("CONSENT_OUTDATED", { field: "consent.agreedVersion" });
      }
      if (request.conditionsConsentVersion !== null && request.conditionsConsentVersion !== terms.conditionsVersion) {
        throw new GuestCheckoutError("CONSENT_OUTDATED", { field: "conditionsConsent.version" });
      }
      if (request.conditionsConsentVersion === null && terms.conditionsVersion !== null) throw invalid("conditionsConsent");

      const headCount = request.adultCount + request.childCount;
      if (headCount < terms.minimumParticipants || headCount > terms.maxPartySize) throw invalid("adultCount");
      if (request.childCount > 0 && terms.childPricing === null) throw invalid("childCount");
      if (request.adultCount < 1 && terms.childPricing?.adultRequired !== false) throw invalid("adultCount");
      const totalYen = product.unitAmount * request.adultCount + (terms.childPricing?.priceYen ?? 0) * request.childCount;
      if (request.expectedTotalYen !== totalYen) throw new GuestCheckoutError("PRICE_CHANGED", { currentTotalYen: totalYen });
      // Unreachable with the ¥50 minimum and today's rates; a fee Stripe would refuse is not for sale.
      if (!chargeablePlatformFee(totalYen, settings.platformFeeBasisPoints)) throw new StoreNotFoundError("experience for sale");
      if (request.bookingQuestionsFingerprint !== terms.bookingQuestionsFingerprint) throw new GuestCheckoutError("QUESTIONS_CHANGED");
      const answers = checkedAnswers(terms.bookingQuestions, request.answers);

      // Lapsed holds of the provider become EXPIRED here, under the provider inventory lock this transaction
      // already holds, so a stale HOLD does not linger without a scheduled job (#285 slice 4). It is
      // bookkeeping: stored inventory (evaluateStoredInventories counts a HOLD only while hold_expires_at is
      // after now) and the hold limits below (hold_expires_at > clock_timestamp()) already leave such a hold
      // out, so no answer changes. Bounded, so the limits keep their time condition for the rest.
      await expireLapsedHolds(client, providerId, GUEST_BOOKING_LIMITS.lapsedHoldsExpiredPerCheckout);

      const started = await client.query<DbRow>(
        `SELECT count(*)::int AS started,
                GREATEST(1, ceil(extract(epoch FROM min(created_at) + interval '60 minutes' - clock_timestamp())))::int AS retry_after
           FROM booking_guests
          WHERE provider_id=$1 AND guest_email_key=lower($2) AND created_at > clock_timestamp() - interval '60 minutes'`,
        [providerId, request.guestEmail],
      );
      if (Number(started.rows[0]!.started) >= GUEST_BOOKING_LIMITS.bookingsPerGuestPerHour) {
        throw new GuestCheckoutError("RATE_LIMITED", { retryAfterSeconds: Number(started.rows[0]!.retry_after) });
      }
      const holds = await client.query<DbRow>(
        `SELECT count(*)::int AS by_product, count(*) FILTER (WHERE g.guest_email_key = lower($3))::int AS by_guest
           FROM bookings b
           LEFT JOIN booking_guests g ON g.provider_id=b.provider_id AND g.booking_id=b.id
          WHERE b.provider_id=$1 AND b.product_id=$2 AND b.status='HOLD' AND b.hold_expires_at > clock_timestamp()`,
        [providerId, productId, request.guestEmail],
      );
      if (Number(holds.rows[0]!.by_guest) >= GUEST_BOOKING_LIMITS.activeHoldsPerGuestPerProduct
        || Number(holds.rows[0]!.by_product) >= GUEST_BOOKING_LIMITS.activeHoldsPerProduct) {
        throw new GuestCheckoutError("HOLD_LIMIT");
      }

      const notScheduled = (occurrenceReason: GuestCheckoutOccurrenceReason) => new GuestCheckoutError("OCCURRENCE_INVALID", { occurrenceReason });
      if (request.occurrenceDate < today || request.occurrenceDate > addLocalDays(today, GUEST_BOOKING_LIMITS.windowDays - 1)) {
        throw notScheduled("NOT_SCHEDULED");
      }
      const candidates = await expandRules(client, providerId, [rule], request.occurrenceDate, request.occurrenceDate);
      if (candidates.length === 0) throw notScheduled("NOT_SCHEDULED");
      if (candidates.length > 1) throw notScheduled("UNAVAILABLE");
      const occurrence = await materializeAndLockOccurrence(client, providerId, productId, candidates[0]!.occurrence.id);

      let placed: Awaited<ReturnType<typeof placeBookingHold>>;
      try {
        placed = await placeBookingHold(client, product, occurrence, {
          seats: headCount,
          idempotencyKey,
          holdSeconds: request.holdSeconds,
          guest: {
            breakdown: { adultCount: request.adultCount, childCount: request.childCount, childUnitAmount: terms.childPricing?.priceYen ?? null },
            cancellationPolicy: terms.cancellationPolicy,
            platformFee: { supportEnabled: settings.supportEnabled, basisPoints: settings.platformFeeBasisPoints },
          },
        });
      } catch (error) {
        if (error instanceof BookingUnavailableError) throw checkoutErrorFor(error);
        throw error;
      }
      await client.query(
        `INSERT INTO booking_guests (
           provider_id, booking_id, guest_name, guest_email, guest_email_key, guest_phone, guest_language, note,
           answers, adult_count, child_count, terms_consent_version, conditions_consent_version,
           client_request_key, request_fingerprint, utm
         ) VALUES ($1,$2,$3,$4,lower($4),$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15::jsonb)`,
        [
          providerId, placed.bookingRowId, request.guestName, request.guestEmail, request.guestPhone, request.guestLanguage, request.note,
          JSON.stringify(answers), request.adultCount, request.childCount, request.termsConsentVersion, request.conditionsConsentVersion,
          request.clientRequestKey, request.fingerprint, JSON.stringify(request.utm),
        ],
      );
      return startResult(placed.booking, product.publicTitle, request.guestEmail, null);
    });
  }

  /**
   * Records the Stripe Checkout Session of a held guest booking, once. The same session again changes
   * nothing; another session, or a booking that is no longer an active hold, is a StoreConflictError.
   */
  async attachCheckoutSession(publicBookingId: string, sessionRef: string): Promise<void> {
    if (typeof publicBookingId !== "string" || !UUID.test(publicBookingId)) throw new StoreValidationError("publicBookingId must be a UUID.");
    if (typeof sessionRef !== "string" || !SESSION_REF.test(sessionRef)) throw new StoreValidationError("sessionRef is invalid.");
    await withTransaction(this.#pool, async (client) => {
      const found = await client.query<DbRow>(
        `SELECT g.provider_id, g.booking_id, g.checkout_session_ref, b.status,
                b.hold_expires_at > clock_timestamp() AS hold_active
           FROM booking_guests g
           JOIN bookings b ON b.provider_id=g.provider_id AND b.id=g.booking_id
          WHERE b.public_booking_id=$1::uuid
          FOR UPDATE OF g`,
        [publicBookingId],
      );
      const row = found.rows[0];
      if (row === undefined) throw new StoreNotFoundError("guest booking");
      if (row.checkout_session_ref === sessionRef) return;
      if (row.checkout_session_ref !== null) throw new StoreConflictError("Another Checkout Session is already attached to this booking.");
      if (row.status !== "HOLD" || row.hold_active !== true) throw new StoreConflictError("Only an active hold can take a Checkout Session.");
      await client.query(
        "UPDATE booking_guests SET checkout_session_ref=$3 WHERE provider_id=$1 AND booking_id=$2",
        [row.provider_id, row.booking_id, sessionRef],
      );
    });
  }

  /**
   * Gives back the seats of a guest's hold whose Stripe Checkout Session ended unpaid (#285 slice 4): under
   * the provider inventory lock, a booking still HOLD whose recorded Session (booking_guests) is this one
   * becomes EXPIRED and its occurrence is recalculated. Anything else changes nothing: the same event again,
   * a booking already expired, confirmed, under payment review or cancelled, a Session other than the one
   * recorded (or none). Each event is recorded once in stripe_webhook_events, as confirmBookingPayment
   * records payments, with the outcome EXPIRED or IGNORED (migration 0026). A payment that still arrives for
   * the released hold goes to PAYMENT_REVIEW there, never taking the seats again. StoreNotFoundError when
   * the booking does not exist; StoreConflictError when the event's account is not the booking's seller or
   * its ID was recorded for another booking.
   */
  async releaseGuestHold(input: ReleaseGuestHoldInput): Promise<GuestHoldRelease> {
    if (typeof input.publicBookingId !== "string" || !UUID.test(input.publicBookingId)) throw new StoreValidationError("publicBookingId must be a UUID.");
    if (typeof input.checkoutSessionRef !== "string" || !SESSION_REF.test(input.checkoutSessionRef)) throw new StoreValidationError("checkoutSessionRef is invalid.");
    assertNonEmptyText(input.connectedAccountId, "connectedAccountId", 256);
    assertNonEmptyText(input.stripeEventId, "stripeEventId", 256);
    if (!ENDED_SESSION_EVENTS.has(input.stripeEventType)) throw new StoreValidationError("stripeEventType must end a Checkout Session unpaid.");
    assertCanonicalInstant(input.eventOccurredAtUtc, "eventOccurredAtUtc");
    const located = await this.#pool.query<DbRow>("SELECT provider_id FROM bookings WHERE public_booking_id=$1::uuid", [input.publicBookingId]);
    if (located.rows[0] === undefined) throw new StoreNotFoundError("booking");
    const providerId = String(located.rows[0].provider_id);

    return withTransaction(this.#pool, async (client) => {
      await lockProviderInventory(client, providerId);
      // The lock confirmBookingPayment takes for the same event ID.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 1))", [input.stripeEventId]);
      const found = await client.query<DbRow>(
        `SELECT id, ${BOOKING_COLUMNS} FROM bookings
          WHERE provider_id=$1 AND public_booking_id=$2::uuid FOR UPDATE`,
        [providerId, input.publicBookingId],
      );
      const row = found.rows[0];
      if (row === undefined) throw new StoreNotFoundError("booking");
      const booking = bookingFromRow(row);
      if (booking.sellerSnapshot.stripeConnectAccountRef !== input.connectedAccountId) {
        throw new StoreConflictError("Stripe event account does not match the booking seller snapshot.");
      }
      const recorded = await client.query<DbRow>(
        `SELECT event_id FROM stripe_webhook_events
          WHERE event_id=$1 AND provider_id=$2 AND booking_id=$3`,
        [input.stripeEventId, providerId, row.id],
      );
      if (recorded.rows[0] !== undefined) return { status: booking.status, released: false, duplicateEvent: true };

      const guest = await client.query<DbRow>(
        "SELECT checkout_session_ref FROM booking_guests WHERE provider_id=$1 AND booking_id=$2",
        [providerId, row.id],
      );
      const release = booking.status === "HOLD" && guest.rows[0]?.checkout_session_ref === input.checkoutSessionRef;
      const inserted = await client.query<DbRow>(
        `INSERT INTO stripe_webhook_events
           (event_id, provider_id, event_type, booking_id, occurred_at, outcome)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT DO NOTHING RETURNING event_id`,
        [input.stripeEventId, providerId, input.stripeEventType, row.id, input.eventOccurredAtUtc, release ? "EXPIRED" : "IGNORED"],
      );
      // Under the event lock, an ID that is taken but not for this booking belongs to another one.
      if (inserted.rows[0] === undefined) throw new StoreConflictError("Stripe event ID is already used outside this booking scope.");
      if (!release) return { status: booking.status, released: false, duplicateEvent: false };

      await client.query(
        "UPDATE bookings SET status='EXPIRED', updated_at=clock_timestamp() WHERE provider_id=$1 AND id=$2",
        [providerId, row.id],
      );
      await enqueueCalendarRecalculation(client, {
        providerId, aggregateType: "schedule_occurrence", aggregateId: booking.occurrenceId, cause: "booking_hold_released",
      });
      return { status: "EXPIRED", released: true, duplicateEvent: false };
    });
  }

  /**
   * Blanks the guest's name, address, phone, note, answers and UTM of bookings whose occurrence ended
   * (a cancelled one: was cancelled) before `endedBefore` (never after now), at most `limit` per call;
   * returns how many were erased. A payment still under review keeps its guest. The owner decided
   * (2026-10-31, #285) one year, as NIHO's data inventory does; the job that calls this with
   * now − 1 year comes with the mail worker (#285 slice 5). A booking whose refund is not settled (Stripe
   * has not answered, or it failed and support has not closed it) or whose "Ask to cancel" is still open
   * keeps its guest too (#285 slice 7); with the guest go the host's cancellation note and support's words
   * to the guest. Disputes join the exclusion when they exist.
   */
  async eraseGuestData(options: { readonly endedBefore: string; readonly limit?: number }): Promise<number> {
    assertCanonicalInstant(options.endedBefore, "endedBefore");
    const limit = options.limit ?? 1_000;
    if (!Number.isInteger(limit) || limit < 1 || limit > 5_000) throw new StoreValidationError("limit must be from 1 to 5000.");
    const result = await this.#pool.query<DbRow>(
      `WITH due AS (
         SELECT g.provider_id, g.booking_id
           FROM booking_guests g
           JOIN bookings b ON b.provider_id=g.provider_id AND b.id=g.booking_id
          WHERE g.pii_erased_at IS NULL
            AND b.status <> 'PAYMENT_REVIEW'
            AND NOT EXISTS (
              SELECT 1 FROM booking_refunds r
               WHERE r.provider_id = b.provider_id AND r.booking_id = b.id
                 AND (r.status IN ('REQUESTED', 'PENDING') OR (r.status = 'FAILED' AND r.closed_at IS NULL)))
            AND NOT EXISTS (
              SELECT 1 FROM booking_cancellation_requests q
               WHERE q.provider_id = b.provider_id AND q.booking_id = b.id AND q.status = 'OPEN')
            AND CASE WHEN b.status = 'CANCELLED' THEN COALESCE(b.cancelled_at, (b.occurrence_snapshot->>'endUtc')::timestamptz)
                     ELSE (b.occurrence_snapshot->>'endUtc')::timestamptz END
                < LEAST($1::timestamptz, clock_timestamp())
          ORDER BY g.provider_id, g.booking_id
          LIMIT $2
          FOR UPDATE OF g SKIP LOCKED
       )
       , erased AS (
         UPDATE booking_guests g
            SET guest_name=NULL, guest_email=NULL, guest_email_key=NULL, guest_phone=NULL, note=NULL,
                answers=NULL, utm=NULL, pii_erased_at=clock_timestamp()
           FROM due
          WHERE g.provider_id=due.provider_id AND g.booking_id=due.booking_id
          RETURNING g.provider_id, g.booking_id
       ), notes AS (
         UPDATE bookings b SET cancellation_note=NULL
           FROM erased e
          WHERE b.provider_id=e.provider_id AND b.id=e.booking_id AND b.cancellation_note IS NOT NULL
       ), messages AS (
         UPDATE booking_cancellation_requests q SET decline_message=NULL
           FROM erased e
          WHERE q.provider_id=e.provider_id AND q.booking_id=e.booking_id AND q.decline_message IS NOT NULL
       )
       SELECT count(*)::int AS erased FROM erased`,
      [options.endedBefore, limit],
    );
    return Number(result.rows[0]?.erased ?? 0);
  }
}
