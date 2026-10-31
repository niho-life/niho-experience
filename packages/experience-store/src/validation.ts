import {
  assertUtcInstant,
  createBookingOccurrenceSnapshot,
  parseBusyIntervals,
  type BookingOccurrenceSnapshot,
  type BusyInterval,
  type GoogleSyncStatus,
  type Occurrence,
} from "@niho-experience/experience-domain";
import { StoreValidationError } from "./errors.ts";
import type { GuestCancellationPolicy, PlatformFeeSnapshot, PricingBreakdown, PricingSnapshot, SellerSnapshot } from "./types.ts";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const CURRENCY = /^[A-Z]{3}$/;

export function assertStoreIdentifier(value: string, path: string): void {
  if (!IDENTIFIER.test(value)) throw new StoreValidationError(`${path} must be a stable 1-256 character identifier.`);
}

export function assertNonEmptyText(value: string, path: string, maxLength = 512): void {
  if (value.trim().length === 0 || value.length > maxLength) {
    throw new StoreValidationError(`${path} must contain 1-${maxLength} characters.`);
  }
}

export function normalizeCurrency(value: string): string {
  const currency = value.toUpperCase();
  if (!CURRENCY.test(currency)) throw new StoreValidationError("currency must be a three-letter ISO currency code.");
  return currency;
}

export function assertMoney(value: number, path: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 9_999_999_999) {
    throw new StoreValidationError(`${path} must be a non-negative safe integer in minor currency units.`);
  }
}

export function assertSeats(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 1_000) {
    throw new StoreValidationError("seats must be an integer from 1 to 1000.");
  }
}

export function assertCanonicalInstant(value: string, path: string): void {
  try {
    assertUtcInstant(value, path);
  } catch (error) {
    throw new StoreValidationError(`${path} must be a canonical UTC instant.`, { cause: error });
  }
}

export function validateBusySync(
  attemptedAtUtc: string,
  freshUntilUtc: string,
  intervals: readonly BusyInterval[],
): readonly BusyInterval[] {
  assertCanonicalInstant(attemptedAtUtc, "attemptedAtUtc");
  assertCanonicalInstant(freshUntilUtc, "freshUntilUtc");
  if (freshUntilUtc <= attemptedAtUtc) {
    throw new StoreValidationError("freshUntilUtc must be after attemptedAtUtc.");
  }
  return parseBusyIntervals(intervals);
}

export function effectiveGoogleSyncStatus(
  storedStatus: GoogleSyncStatus,
  freshUntilUtc: string | undefined,
  nowUtc: string,
): GoogleSyncStatus {
  if (storedStatus === "FAILED") return "FAILED";
  return storedStatus === "FRESH" && freshUntilUtc !== undefined && freshUntilUtc > nowUtc ? "FRESH" : "STALE";
}

/** A guest booking's party and its sale terms; without it every seat costs the product's unit amount. */
export interface GuestPricingInput {
  readonly breakdown: PricingBreakdown;
  readonly cancellationPolicy: GuestCancellationPolicy;
  /** The provider's sale settings at booking; the amount follows from the total. */
  readonly platformFee: Omit<PlatformFeeSnapshot, "amount">;
}

/**
 * NIHO's fee on a total, in yen. Rounded down: docs/api-contract.md (§9.2, §9.3) states the rates but no
 * rounding, and rounding down never charges the provider more than the rate.
 */
export function platformFeeAmount(totalAmount: number, basisPoints: number): number {
  return Math.floor((totalAmount * basisPoints) / 10_000);
}

/** Stripe takes an application fee only above zero and below the charge. */
export function chargeablePlatformFee(totalAmount: number, basisPoints: number): boolean {
  const amount = platformFeeAmount(totalAmount, basisPoints);
  return Number.isSafeInteger(amount) && amount >= 1 && amount < totalAmount;
}

function guestPlatformFee(settings: GuestPricingInput["platformFee"], totalAmount: number): PlatformFeeSnapshot {
  const { supportEnabled, basisPoints } = settings;
  if (basisPoints !== (supportEnabled ? 1500 : 1000)) throw new StoreValidationError("The platform fee does not match the support setting.");
  if (!chargeablePlatformFee(totalAmount, basisPoints)) throw new StoreValidationError("The platform fee must be at least 1 and below the booking total.");
  return { supportEnabled, basisPoints, amount: platformFeeAmount(totalAmount, basisPoints) };
}

export function buildSnapshots(
  occurrence: Occurrence,
  seats: number,
  acceptedAtUtc: string,
  product: {
    readonly providerId: string;
    readonly currency: string;
    readonly unitAmount: number;
    readonly cancellationTermsRef: string;
    readonly sellerNihoAccountRef: string;
    readonly stripeConnectAccountRef: string;
    readonly sellerDisplayName: string;
  },
  guest?: GuestPricingInput,
): {
  readonly occurrenceSnapshot: BookingOccurrenceSnapshot;
  readonly pricingSnapshot: PricingSnapshot;
  readonly sellerSnapshot: SellerSnapshot;
} {
  assertSeats(seats);
  assertMoney(product.unitAmount, "unitAmount");
  let totalAmount = product.unitAmount * seats;
  if (guest !== undefined) {
    const { adultCount, childCount, childUnitAmount } = guest.breakdown;
    if (adultCount + childCount !== seats || (childCount > 0 && childUnitAmount === null)) {
      throw new StoreValidationError("The guest party does not match the booked seats.");
    }
    if (childUnitAmount !== null) assertMoney(childUnitAmount, "childUnitAmount");
    totalAmount = product.unitAmount * adultCount + (childUnitAmount ?? 0) * childCount;
  }
  if (!Number.isSafeInteger(totalAmount)) throw new StoreValidationError("booking total exceeds the safe integer range.");
  return {
    occurrenceSnapshot: createBookingOccurrenceSnapshot(occurrence, seats, acceptedAtUtc),
    pricingSnapshot: {
      currency: normalizeCurrency(product.currency),
      unitAmount: product.unitAmount,
      seats,
      totalAmount,
      cancellationTermsRef: product.cancellationTermsRef,
      ...(guest === undefined ? {} : {
        breakdown: { ...guest.breakdown },
        cancellationPolicy: guest.cancellationPolicy,
        platformFee: guestPlatformFee(guest.platformFee, totalAmount),
      }),
    },
    sellerSnapshot: {
      experienceProviderId: product.providerId,
      nihoAccountRef: product.sellerNihoAccountRef,
      stripeConnectAccountRef: product.stripeConnectAccountRef,
      displayName: product.sellerDisplayName,
    },
  };
}
