import type {
  BookingOccurrenceSnapshot,
  BusyInterval,
  GoogleSyncStatus,
  OccurrenceOverride,
  OccurrenceSalesState,
  ScheduleRule,
} from "@niho-experience/experience-domain";

export type MembershipRole = "OWNER" | "EDITOR" | "VIEWER";
export type ProductStatus = "DRAFT" | "PUBLISHED" | "ARCHIVED";
export type BookingStatus = "HOLD" | "CONFIRMED" | "EXPIRED" | "CANCELLED" | "PAYMENT_REVIEW";
export type BookingMode = "SEAT" | "PRIVATE_GROUP";
export type InventoryResourceKind = "VENUE" | "INSTRUCTOR" | "EQUIPMENT";

export interface HostActor {
  /** Server-established ceiling: current NIHO membership cannot widen an operator grant. */
  readonly calendarScope?: "OPERATOR";
  readonly providerId: string;
  readonly nihoUserId: string;
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

export interface PricingSnapshot {
  readonly currency: string;
  readonly unitAmount: number;
  readonly seats: number;
  readonly totalAmount: number;
  readonly cancellationTermsRef: string;
}

export interface SellerSnapshot {
  readonly experienceProviderId: string;
  readonly nihoAccountRef: string;
  readonly stripeConnectAccountRef: string;
  readonly displayName: string;
}

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
