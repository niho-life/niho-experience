import type { GuestCancellationPolicy, PricingSnapshot } from "./types.ts";

export interface ResolvedCancellationTerms {
  readonly cancellationWindowMinutesBeforeStart: number | null;
  readonly refundBasisPoints: number;
}

const LEGACY_POLICY: Readonly<Record<GuestCancellationPolicy, ResolvedCancellationTerms>> = {
  FREE_UNTIL_24H: { cancellationWindowMinutesBeforeStart: 1_440, refundBasisPoints: 10_000 },
  FREE_UNTIL_48H: { cancellationWindowMinutesBeforeStart: 2_880, refundBasisPoints: 10_000 },
  NONE: { cancellationWindowMinutesBeforeStart: null, refundBasisPoints: 0 },
};

/** Resolve a new terms snapshot or an older enum-only snapshot without changing historical bookings. */
export function cancellationTermsOf(pricing: PricingSnapshot | Record<string, unknown>): ResolvedCancellationTerms {
  const snapshot = pricing as Record<string, unknown>;
  const bookingTerms = typeof snapshot.bookingTerms === "object" && snapshot.bookingTerms !== null && !Array.isArray(snapshot.bookingTerms)
    ? snapshot.bookingTerms as Record<string, unknown>
    : {};
  const minutes = bookingTerms.cancellationWindowMinutesBeforeStart;
  const rate = bookingTerms.cancellationRefundBasisPoints;
  if ((minutes === null || (typeof minutes === "number" && Number.isInteger(minutes) && minutes >= 0 && minutes <= 2_147_483_647))
    && typeof rate === "number" && Number.isInteger(rate) && rate >= 0 && rate <= 10_000
    && (minutes !== null || rate === 0)) {
    return { cancellationWindowMinutesBeforeStart: minutes, refundBasisPoints: rate };
  }
  const policy = snapshot.cancellationPolicy;
  return typeof policy === "string" && policy in LEGACY_POLICY
    ? LEGACY_POLICY[policy as GuestCancellationPolicy]
    : { cancellationWindowMinutesBeforeStart: null, refundBasisPoints: 0 };
}

export function freeCancellationDeadlineUtc(startUtc: string, minutesBeforeStart: number | null): string | null {
  if (minutesBeforeStart === null) return null;
  const deadline = Date.parse(startUtc) - minutesBeforeStart * 60_000;
  if (!Number.isFinite(deadline)) return null;
  return new Date(deadline).toISOString();
}
