import type { GuestCancellationPolicy } from "@niho-experience/experience-store";

/*
 * How a guest booking made on this site reads in English (#285): the confirmation email and the guest's booking
 * page (slice 6) say the date, the party, the price and the cancellation policy in the same words.
 */

export const DATE_LONG = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long", year: "numeric" });
export const DATE_SHORT = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short", year: "numeric" });

/** A calendar date (YYYY-MM-DD) in words; the date itself, whatever the server's zone. */
export function calendarDate(localDate: string, format: Intl.DateTimeFormat = DATE_LONG): string {
  const [year, month, day] = localDate.split("-").map(Number);
  return format.format(new Date(Date.UTC(year!, month! - 1, day!))).replace(",", "");
}

export const zoneName = (timeZone: string) => (timeZone === "Asia/Tokyo" ? "Japan time" : timeZone);

/** "Fri 13 Nov, 10:00" for an instant in the experience's time zone. */
export function zonedMoment(instant: number, timeZone: string): string {
  const date = new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short" }).format(instant).replace(",", "");
  const clock = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(instant);
  return `${date}, ${clock}`;
}

export function money(amount: number, currency: string): string {
  const format = new Intl.NumberFormat("en-US", { style: "currency", currency });
  const digits = format.resolvedOptions().maximumFractionDigits ?? 0;
  return format.format(amount / 10 ** digits);
}

export function party(adults: number, children: number): string {
  const parts = [
    ...(adults ? [`${adults} adult${adults === 1 ? "" : "s"}`] : []),
    ...(children ? [`${children} child${children === 1 ? "" : "ren"}`] : []),
  ];
  return parts.join(", ");
}

const HOURS: Readonly<Record<string, number>> = { FREE_UNTIL_24H: 24, FREE_UNTIL_48H: 48 };

/** The policy fixed at booking, in plain words, with the moment free cancellation ends; null without a policy. */
export function cancellationWords(
  booking: { readonly cancellationPolicy: GuestCancellationPolicy | null; readonly startUtc: string; readonly timeZone: string },
  now: Date,
): string | null {
  if (booking.cancellationPolicy === null) return null;
  if (booking.cancellationPolicy === "NONE") return "This booking is non-refundable.";
  const hours = HOURS[booking.cancellationPolicy]!;
  const deadline = Date.parse(booking.startUtc) - hours * 3_600_000;
  if (!Number.isFinite(deadline) || deadline <= now.getTime()) {
    return `Free cancellation ends ${hours} hours before the start, so this booking is now non-refundable.`;
  }
  return `Free cancellation until ${zonedMoment(deadline, booking.timeZone)} ${zoneName(booking.timeZone)} (${hours} hours before the start). After that, the booking is non-refundable.`;
}
