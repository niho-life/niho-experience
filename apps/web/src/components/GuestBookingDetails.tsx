import type { GuestBookingView, GuestRefundView } from "@niho-experience/experience-store";
import type { ReactNode } from "react";
import { DATE_LONG, REFUND_TIMING, calendarDate, cancellationWords, cancelledBy, money, party, zoneName, zonedMoment } from "@/lib/booking-words";
import { BookingCancel } from "./BookingCancel";
import { BookingSignOut } from "./BookingSignOut";
import { FindBookingForm } from "./FindBookingForm";
import { HandIcon } from "./HandIcon";
import { ButtonLink, Notice, Pill } from "./ui";

const STATUS = {
  CONFIRMED: { label: "Confirmed", tone: "neutral" },
  PAYMENT_REVIEW: { label: "Payment under review", tone: "warn" },
  CANCELLED: { label: "Cancelled", tone: "muted" },
} as const;

const moment = (instant: string, timeZone: string) => `${zonedMoment(Date.parse(instant), timeZone)} ${zoneName(timeZone)}`;

/** One refund in words: on its way, done (with when), or failed (support will write). */
function refundLine(refund: GuestRefundView, timeZone: string): string {
  const sum = money(refund.amount, refund.currency);
  if (refund.status === "REFUNDED") return `${sum} was refunded to the card you paid with${refund.refundedAtUtc ? ` on ${moment(refund.refundedAtUtc, timeZone)}` : ""}. ${REFUND_TIMING}`;
  if (refund.status === "FAILED") return `We couldn't refund ${sum} to your card. NIHO support will email you about it.`;
  return `A refund of ${sum} is on its way to the card you paid with. We'll email you when it's done.`;
}

/**
 * 取消 (#285 slice 7): what the guest can do now, decided by the snapshot's terms and the database's clock. Before the
 * deadline, "Cancel and get a full refund"; after it (or with no free cancellation), "Ask to cancel", which NIHO support
 * answers by email while the booking stays confirmed. A cancelled booking shows its refunds as they are, never a
 * refund that has not been made.
 */
function CancelSection({ booking }: { booking: GuestBookingView }) {
  const p = "mt-3 text-[0.9375rem] text-ink-soft";
  let body: ReactNode;
  if (booking.status === "CANCELLED") {
    body = booking.refunds.length
      ? booking.refunds.map((refund, index) => <p key={index} className={p}>{refundLine(refund, booking.timeZone)}</p>)
      : <p className={p}>No refund was made for this booking.</p>;
  } else if (booking.status === "PAYMENT_REVIEW") {
    body = <p className={p}>NIHO support will email you about your payment. For questions, reply to your confirmation email.</p>;
  } else if (booking.experienceEnded) {
    body = <p className={p}>This experience has ended. For questions about it, reply to your confirmation email and NIHO support will help.</p>;
  } else if (booking.freeCancellationOpen && booking.freeCancellationUntilUtc) {
    const total = money(booking.totalAmount, booking.currency);
    body = (
      <>
        <p className={p}>You can cancel for free until {moment(booking.freeCancellationUntilUtc, booking.timeZone)}. We&apos;ll refund {total} in full to the card you paid with.</p>
        <BookingCancel
          publicBookingId={booking.publicBookingId}
          choice="FULL_REFUND"
          shownDeadlineUtc={booking.freeCancellationUntilUtc}
          refundWords={`We'll refund ${total} in full to the card you paid with. ${REFUND_TIMING}`}
        />
      </>
    );
  } else if (booking.cancellationRequest?.status === "OPEN") {
    body = <p className={p}>You asked to cancel on {moment(booking.cancellationRequest.requestedAtUtc, booking.timeZone)}. NIHO support will reply by email. Your booking stays confirmed until then.</p>;
  } else if (booking.cancellationRequest?.status === "DECLINED") {
    body = (
      <>
        <p className={p}>NIHO support replied to your request to cancel. Your booking stays confirmed.</p>
        {booking.cancellationRequest.declineMessage ? (
          <blockquote className="mt-3 border-l-4 border-line pl-4 text-[0.9375rem] whitespace-pre-line [overflow-wrap:anywhere]">{booking.cancellationRequest.declineMessage}</blockquote>
        ) : null}
        <p className={p}>To reply, answer the email from NIHO support.</p>
      </>
    );
  } else {
    body = (
      <>
        <p className={p}>
          {booking.cancellationPolicy === "NONE" ? "This booking is non-refundable." : "Free cancellation has ended."} You can still ask to cancel: NIHO support will look at your request and reply by email. Your booking stays confirmed until then.
        </p>
        <BookingCancel publicBookingId={booking.publicBookingId} choice="REQUEST" shownDeadlineUtc={booking.freeCancellationUntilUtc} refundWords={null} />
      </>
    );
  }
  return (
    <section aria-labelledby="booking-changes" className="mt-8">
      <h2 id="booking-changes" className="font-sans text-sm font-extrabold tracking-[0.04em] text-muted uppercase">
        {booking.status === "CANCELLED" ? "Refund" : "Cancel"}
      </h2>
      {body}
    </section>
  );
}

/**
 * The guest's booking (#285 slice 6, docs/guest-booking.md): what was booked, for when and whom, what was paid and the
 * cancellation policy fixed at booking, and cancelling it (slice 7). Messages with the host come later (slice 6b);
 * until then the page says so and points to NIHO support, with no control that does nothing.
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
            {cancelledBy(booking)}
            {booking.cancelledAtUtc ? ` Cancelled on ${moment(booking.cancelledAtUtc, booking.timeZone)}.` : null}
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
      <CancelSection booking={booking} />

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
