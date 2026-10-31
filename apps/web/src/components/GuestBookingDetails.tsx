import type { GuestBookingView } from "@niho-experience/experience-store";
import { DATE_LONG, calendarDate, cancellationWords, money, party, zoneName, zonedMoment } from "@/lib/booking-words";
import { BookingSignOut } from "./BookingSignOut";
import { FindBookingForm } from "./FindBookingForm";
import { HandIcon } from "./HandIcon";
import { ButtonLink, Notice, Pill } from "./ui";

const STATUS = {
  CONFIRMED: { label: "Confirmed", tone: "neutral" },
  PAYMENT_REVIEW: { label: "Payment under review", tone: "warn" },
  CANCELLED: { label: "Cancelled", tone: "muted" },
} as const;

/**
 * The guest's booking (#285 slice 6, docs/guest-booking.md), read only: what was booked, for when and whom, what was
 * paid and the cancellation policy fixed at booking. Messages with the host and cancellation come later (slices 6b
 * and 7); until then the page says so and points to NIHO support, with no control that does nothing.
 */
export function GuestBookingDetails({ booking, now }: { booking: GuestBookingView; now: Date }) {
  const status = STATUS[booking.status];
  const policy = booking.status === "CANCELLED" ? null : cancellationWords(booking, now);
  const rows: [string, string][] = [
    ["Date", calendarDate(booking.localDate, DATE_LONG)],
    ["Time", `${booking.localStartTime} ${zoneName(booking.timeZone)}`],
    ["Guests", party(booking.adultCount, booking.childCount)],
    ["Total paid", money(booking.totalAmount, booking.currency)],
    ["Host", booking.hostDisplayName],
    ["Booked by", booking.guestName],
    ["Booked on", `${zonedMoment(Date.parse(booking.bookedAtUtc), booking.timeZone)} ${zoneName(booking.timeZone)}`],
    ["Booking reference", booking.publicBookingId],
  ];
  return (
    <div className="container-page max-w-2xl py-12">
      <p className="hand text-[1.75rem]">your booking</p>
      <h1 className="mt-1 text-3xl [overflow-wrap:anywhere]">{booking.experienceTitle}</h1>
      <p className="mt-3 flex flex-wrap items-center gap-2">
        <Pill tone={status.tone}>{status.label}</Pill>
      </p>
      {booking.status === "PAYMENT_REVIEW" ? (
        <div className="mt-5">
          <Notice tone="warn" title="Your place isn't confirmed yet">
            Your payment reached us after your hold on the place ended. NIHO support will email you about it.
          </Notice>
        </div>
      ) : null}
      {booking.status === "CANCELLED" ? (
        <div className="mt-5">
          <Notice tone="neutral" title="This booking was cancelled">
            {booking.cancelledAtUtc ? `Cancelled on ${zonedMoment(Date.parse(booking.cancelledAtUtc), booking.timeZone)} ${zoneName(booking.timeZone)}.` : null}
          </Notice>
        </div>
      ) : null}
      <dl className="mt-7 grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-2.5 border-t border-line pt-6">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-ink-soft">{label}</dt>
            <dd className="font-bold [overflow-wrap:anywhere]">{value}</dd>
          </div>
        ))}
      </dl>
      {policy ? <p className="mt-5 text-[0.9375rem] text-ink-soft">{policy}</p> : null}
      <div className="mt-6 flex flex-wrap gap-3">
        <ButtonLink href={`/experiences/${encodeURIComponent(booking.experienceSlug)}`} variant="secondary">See the experience</ButtonLink>
      </div>

      <section aria-labelledby="booking-messages" className="mt-10 border-t border-line pt-6">
        <h2 id="booking-messages" className="font-sans text-sm font-extrabold tracking-[0.04em] text-muted uppercase">Messages with your host</h2>
        <p className="mt-3 flex items-start gap-2.5 text-[0.9375rem] text-ink-soft">
          <HandIcon name="chat" className="size-6 shrink-0 text-moss" />
          <span>Coming soon: you&apos;ll be able to write to {booking.hostDisplayName} here. For now, reply to your confirmation email and NIHO support will help.</span>
        </p>
      </section>
      <section aria-labelledby="booking-changes" className="mt-8">
        <h2 id="booking-changes" className="font-sans text-sm font-extrabold tracking-[0.04em] text-muted uppercase">Change or cancel</h2>
        <p className="mt-3 flex items-start gap-2.5 text-[0.9375rem] text-ink-soft">
          <HandIcon name="mail" className="size-6 shrink-0 text-moss" />
          <span>Coming soon on this page. For now, reply to your confirmation email and NIHO support will help.</span>
        </p>
      </section>

      <section aria-labelledby="booking-device" className="mt-10 border-t border-line pt-6">
        <h2 id="booking-device" className="font-sans text-sm font-extrabold tracking-[0.04em] text-muted uppercase">This device</h2>
        <p className="mt-3 mb-4 text-[0.9375rem] text-ink-soft">
          This booking stays open in this browser until 30 days after the experience, or until 30 days pass without a visit. On a shared device, sign out when you&apos;re done; you can ask for a new link any time.
        </p>
        <BookingSignOut publicBookingId={booking.publicBookingId} />
      </section>
    </div>
  );
}

/**
 * What `/bookings/{id}` shows without a session for that booking, and for an ID that is not one: the same page, so it
 * says nothing about whether the booking exists.
 */
export function BookingNotOpen() {
  return (
    <div className="container-page max-w-2xl py-12">
      <p className="hand text-[1.75rem]">your booking</p>
      <h1 className="mt-1 text-3xl">Open this booking from your email</h1>
      <p className="mt-3 text-ink-soft">
        Use the &ldquo;View your booking&rdquo; link in your confirmation email. Each link works once; if yours has been used or is too old, we can email you a new one.
      </p>
      <h2 className="mt-8 font-sans text-sm font-extrabold tracking-[0.04em] text-muted uppercase">Send me a new link</h2>
      <FindBookingForm submitLabel="Send me a new link" />
    </div>
  );
}

/** The booking could not be read (the database did not answer): says nothing about the booking either. */
export function BookingUnavailable() {
  return (
    <div className="container-page max-w-2xl py-12">
      <p className="hand text-[1.75rem]">something went wrong</p>
      <h1 className="mt-1 text-3xl">We couldn&apos;t open your booking</h1>
      <p className="mt-3 text-ink-soft">Please try again in a moment. Reloading this page is enough.</p>
    </div>
  );
}
