import type {
  BookingOccurrenceSnapshot,
  BusyInterval,
  GoogleSyncStatus,
  OccurrenceOverride,
  OccurrenceSalesState,
  ScheduleRule,
} from "@niho-experience/experience-domain";

export type MembershipRole = "OWNER" | "COHOST" | "EDITOR" | "VIEWER";
export type ProductStatus = "DRAFT" | "PUBLISHED" | "ARCHIVED";
export type BookingStatus = "HOLD" | "CONFIRMED" | "EXPIRED" | "CANCELLED" | "PAYMENT_REVIEW";
export type BookingMode = "SEAT" | "PRIVATE_GROUP";
export type InventoryResourceKind = "VENUE" | "INSTRUCTOR" | "EQUIPMENT";

export interface HostActor {
  /** Server-established ceiling: current NIHO membership cannot widen an operator grant. */
  readonly calendarScope?: "OPERATOR";
  /** Current NIHO role, normalized to the local read/write role ceiling. */
  readonly calendarRoleCeiling?: MembershipRole;
  readonly providerId: string;
  readonly nihoUserId: string;
}

/** Built only after the HTTP boundary has verified a current NIHO Admin. */
export interface InventoryAdminActor {
  readonly nihoUserId: string;
}

/** Built only after the dedicated NIHO Admin HTTP session is verified. */
export interface PublicationAdminDraftActor {
  readonly nihoUserId: string;
}

export interface InventoryAdminProvider {
  readonly id: string;
  readonly displayName: string;
}

export interface InventoryAdminProduct {
  readonly id: string;
  readonly publicTitle: string;
  readonly sellerDisplayName: string;
  readonly status: ProductStatus;
  readonly inventory?: ProductInventorySetting;
}

export interface InventoryAdminSnapshot {
  readonly providerId: string;
  readonly products: readonly InventoryAdminProduct[];
  readonly resources: readonly InventoryResourceRecord[];
}

export type CalendarAccess =
  | { readonly basis: "MEMBER"; readonly role: MembershipRole }
  | { readonly basis: "OPERATOR"; readonly version: number; readonly assignmentLabel: string };

export interface CalendarProduct {
  readonly id: string;
  readonly publicTitle: string;
  readonly sellerDisplayName: string;
  readonly access: CalendarAccess;
}

export type ProductOperatorInvitationState = "PENDING" | "ACCEPTED" | "REVOKED";

export interface ProductOperatorAssignment {
  readonly providerId: string;
  readonly productId: string;
  readonly productTitle: string;
  readonly sellerDisplayName: string;
  readonly assignmentLabel: string;
  readonly grantVersion: number;
  readonly grantExpiresAtUtc?: string;
}

export interface ProductOperatorInvitationRecord {
  readonly id: string;
  readonly providerId: string;
  readonly productId: string;
  readonly productTitle: string;
  readonly sellerDisplayName: string;
  readonly assignmentLabel: string;
  readonly state: ProductOperatorInvitationState;
  readonly expiresAtUtc: string;
  readonly acceptedNihoUserId?: string;
  readonly acceptedAtUtc?: string;
  readonly revokedAtUtc?: string;
  readonly revision: number;
  readonly createdAtUtc: string;
}

export interface ProductOperatorGrantRecord {
  readonly providerId: string;
  readonly productId: string;
  readonly productTitle: string;
  readonly sellerDisplayName: string;
  readonly nihoUserId: string;
  readonly assignmentLabel: string;
  readonly active: boolean;
  readonly expiresAtUtc?: string;
  readonly version: number;
  readonly grantedAtUtc: string;
  readonly revokedAtUtc?: string;
}

export interface InventoryResourceInput {
  readonly id: string;
  readonly kind: InventoryResourceKind;
  readonly displayName: string;
  readonly active: boolean;
}

export interface InventoryResourceRecord extends InventoryResourceInput {
  readonly providerId: string;
  readonly version: number;
  readonly createdAtUtc: string;
  readonly updatedAtUtc: string;
}

export interface ProductInventoryResourceInput {
  readonly resourceId: string;
  readonly prepareMinutes: number;
  readonly cleanupMinutes: number;
}

export interface ProductInventorySettingInput {
  readonly bookingMode: BookingMode;
  readonly resources: readonly ProductInventoryResourceInput[];
}

export interface ProductInventorySetting extends ProductInventorySettingInput {
  readonly providerId: string;
  readonly productId: string;
  readonly version: number;
}

/** A tenant scope established by a trusted public API or worker before calling the store. */
export interface ProviderScope {
  readonly providerId: string;
}

export interface ProviderMembership {
  readonly providerId: string;
  readonly nihoUserId: string;
  readonly role: MembershipRole;
  readonly active: boolean;
}

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface ProductInput {
  readonly id: string;
  readonly slug: string;
  readonly status: ProductStatus;
  readonly publicTitle: string;
  readonly content: Readonly<Record<string, JsonValue>>;
  readonly currency: string;
  readonly unitAmount: number;
  readonly cancellationTermsRef: string;
  readonly sellerNihoAccountRef: string;
  readonly stripeConnectAccountRef: string;
  readonly sellerDisplayName: string;
  /** Absent on legacy products. New sale-plan products always set this from their immutable active revision. */
  readonly chargeMode?: ExperienceChargeMode;
  /** Product-scoped revision shown to the traveler and required again when checkout starts. */
  readonly salesPlanRevision?: number;
  readonly salesPlan?: ExperienceSalesPlan;
  readonly sellerDisclosureUrl?: string;
  readonly salesAgreementVersion?: string;
  readonly feeBasisPoints?: 1000 | 1500 | 2000;
  readonly paymentDueDays?: number | null;
  readonly paymentDuePolicy?: ManagedPaymentDuePolicy;
  /** Immutable sales-plan policy. Absent historical and owner/direct rows are instant. */
  readonly acceptanceMode?: BookingAcceptanceMode;
}

export interface ProductRecord extends ProductInput {
  readonly providerId: string;
  readonly version: number;
  readonly createdAtUtc: string;
  readonly updatedAtUtc: string;
}

export interface StoredScheduleRule {
  readonly providerId: string;
  readonly productId: string;
  readonly rule: ScheduleRule;
  readonly version: number;
}

export interface StoredOccurrenceOverride {
  readonly override: OccurrenceOverride;
  readonly version: number;
}

export interface StoredOccurrenceSalesState {
  readonly state: OccurrenceSalesState;
  readonly version: number;
}

export interface CalendarCommandReceipt {
  readonly aggregateId: string;
  readonly version: number;
  readonly repeated: boolean;
}

export interface GoogleCalendarConfiguration {
  readonly providerId: string;
  readonly opaqueCalendarId: string;
  readonly blockingEnabled: boolean;
  readonly syncStatus: GoogleSyncStatus;
  readonly lastAttemptedAtUtc?: string;
  readonly lastSucceededAtUtc?: string;
  readonly freshUntilUtc?: string;
  readonly coverageStartUtc?: string;
  readonly coverageEndUtc?: string;
  readonly version: number;
}

export type GuestCancellationPolicy = "FREE_UNTIL_24H" | "FREE_UNTIL_48H" | "NONE";

/** A guest booking prices adults and children apart; seats = adultCount + childCount. */
export interface PricingBreakdown {
  readonly adultCount: number;
  readonly childCount: number;
  /** The child price per seat; null when the product sells no child seats (childCount is then 0). */
  readonly childUnitAmount: number | null;
  /** Exact minimum-charge rule applied to this booking (absent only in legacy snapshots). */
  readonly minimumChargeableParticipants?: number;
}

/** The exact offer rules and consented conditions accepted when checkout starts. */
export interface BookingTermsSnapshot {
  readonly minimumParticipants: number;
  /** Minimum adult-price-equivalent participants charged, even when the party is smaller. */
  readonly minimumChargeableParticipants?: number;
  /** Operations threshold fixed at checkout; intentionally excluded from all guest-facing DTOs. */
  readonly minimumAttendance?: number | null;
  readonly maxPartySize: number;
  readonly cancellationPolicy: GuestCancellationPolicy;
  /** Exact offer-level free-cancellation window and guest refund rate accepted at checkout. */
  readonly cancellationWindowMinutesBeforeStart?: number | null;
  readonly cancellationRefundBasisPoints?: number;
  readonly bookingQuestions: readonly {
    readonly id: string;
    readonly prompt: string;
    readonly description: string | null;
    readonly inputType: "SHORT_TEXT" | "LONG_TEXT" | "SINGLE_SELECT" | "MULTI_SELECT";
    readonly required: boolean;
    readonly options: readonly { readonly id: string; readonly label: string }[];
  }[];
  readonly bookingQuestionsFingerprint: string;
  readonly conditionsVersion: string | null;
}

export interface PricingSnapshot {
  readonly currency: string;
  /** The per-seat price; for a guest booking, the adult price. */
  readonly unitAmount: number;
  readonly seats: number;
  /** What the guest pays. Payment confirmation compares the charge with this, never unitAmount × seats. */
  readonly totalAmount: number;
  /** New snapshots state this explicitly; absent on historical snapshots, where totalAmount determines it. */
  readonly paymentRequired?: boolean;
  readonly cancellationTermsRef: string;
  /** Guest bookings (#285) only. */
  readonly breakdown?: PricingBreakdown;
  /** Guest bookings (#285) only: the cancellation policy fixed at booking. */
  readonly cancellationPolicy?: GuestCancellationPolicy;
  /** Guest bookings only: immutable terms shown and accepted at the time the hold was created. */
  readonly bookingTerms?: BookingTermsSnapshot;
  /** Guest bookings (#285) only: NIHO's fee fixed at booking, the Checkout Session's application fee. */
  readonly platformFee?: PlatformFeeSnapshot;
}

/**
 * NIHO's fee on a guest booking (owner decision 2026-10-31, #285): 10 % with NIHO support off, 15 % with
 * it on, payment fees included, taken from the provider's sale settings when the booking is made.
 */
export interface PlatformFeeSnapshot {
  readonly supportEnabled: boolean;
  readonly basisPoints: 1000 | 1500 | 2000;
  /** floor(totalAmount × basisPoints / 10000) in yen; zero for a free booking, otherwise at least 1 and below totalAmount. */
  readonly amount: number;
  /** Absent on historical rows. Never inferred from the current provider setting. */
  readonly supportConsentVersion?: string;
  /** Host's accepted support agreement revision at booking time; absent on historical rows. */
  readonly supportAgreementRevision?: number;
  /** MANAGED_20 means this is a revenue-share snapshot, not a Stripe application fee. */
  readonly salesPlan?: ExperienceSalesPlan;
}

export interface SellerSnapshot {
  readonly experienceProviderId: string;
  readonly nihoAccountRef: string;
  readonly stripeConnectAccountRef: string;
  readonly displayName: string;
  /** Absent means a historical CONNECT_DIRECT booking. Never fill it from the current product. */
  readonly chargeMode?: ExperienceChargeMode;
  readonly salesPlan?: ExperienceSalesPlan;
  readonly salesPlanRevision?: number;
  readonly feeBasisPoints?: 1000 | 1500 | 2000;
  readonly sellerDisclosureUrl?: string;
  readonly agreementVersion?: string;
  readonly paymentDueDays?: number | null;
  readonly paymentDuePolicy?: ManagedPaymentDuePolicy;
  /** Present on new sales-plan bookings; APPROVAL must be authorized before Checkout is attached or paid. */
  readonly acceptanceMode?: BookingAcceptanceMode;
}

export type ExperienceChargeMode = "PLATFORM" | "CONNECT_DIRECT";
export type ExperienceSalesPlan = "MANAGED_20" | "SUPPORTED_15" | "INDEPENDENT_10";
export type ManagedPaymentDuePolicy = "NEXT_MONTH_END";
export type BookingAcceptanceMode = "INSTANT" | "APPROVAL";

export interface BookingRecord {
  readonly publicBookingId: string;
  readonly providerId: string;
  readonly productId: string;
  readonly occurrenceId: string;
  readonly status: BookingStatus;
  readonly seats: number;
  readonly idempotencyKey: string;
  readonly holdExpiresAtUtc: string;
  readonly occurrenceSnapshot: BookingOccurrenceSnapshot;
  readonly pricingSnapshot: PricingSnapshot;
  readonly sellerSnapshot: SellerSnapshot;
  readonly stripePaymentRef?: string;
  readonly createdAtUtc: string;
  readonly confirmedAtUtc?: string;
}

export interface CreateBookingHoldInput {
  readonly productId: string;
  readonly occurrenceId: string;
  readonly seats: number;
  readonly idempotencyKey: string;
  /** Defaults to the repository setting; bounded to 1-60 minutes. */
  readonly holdSeconds?: number;
}

export interface ConfirmBookingInput {
  readonly publicBookingId: string;
  /** Stripe Connect account on the verified webhook envelope. */
  readonly connectedAccountId: string;
  readonly stripePaymentRef: string;
  readonly stripeEventId: string;
  readonly stripeEventType: string;
  readonly eventOccurredAtUtc: string;
  readonly amount: number;
  readonly currency: string;
}

export interface ConfirmBookingResult {
  readonly booking: BookingRecord;
  readonly duplicateEvent: boolean;
}

export interface RecordGoogleBusySyncInput {
  readonly connectionGeneration?: number;
  readonly opaqueCalendarId: string;
  readonly attemptedAtUtc: string;
  readonly freshUntilUtc: string;
  readonly coverageStartUtc: string;
  readonly coverageEndUtc: string;
  readonly busyIntervals: readonly BusyInterval[];
}

export interface ScheduleView {
  readonly rule: StoredScheduleRule;
  readonly overrides: readonly StoredOccurrenceOverride[];
  readonly salesStates: readonly StoredOccurrenceSalesState[];
}
