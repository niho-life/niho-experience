"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { BOOKING_FIELD_INPUT_CLASS_V1, BOOKING_FIELD_LABEL_CLASS_V1 } from "@niho/experience-presentation/v1";
import { FIND_BOOKING_EMAIL_MAX_LENGTH, requestBookingLinkEmail } from "@/lib/guest-booking-page";
import { Notice, buttonClass } from "./ui";

/** The one answer, whatever the address: it never says whether there is a booking for it. */
export const FIND_BOOKING_SENT = "If we have a booking for this address, we've emailed you a link.";

/**
 * "Find your booking" (#285 slice 6): the address the guest booked with, and a new link to each of its open bookings
 * by email. The page says the same whether or not anything matched. What is typed goes to this site only.
 */
export function FindBookingForm({ submitLabel = "Email me a link" }: { submitLabel?: string }) {
  const alertBox = useRef<HTMLDivElement>(null);
  const [email, setEmail] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (problem) alertBox.current?.focus();
  }, [problem]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending) return;
    const address = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) || address.length > FIND_BOOKING_EMAIL_MAX_LENGTH) {
      setProblem("Please enter the email address you booked with.");
      return;
    }
    setProblem(null);
    setSending(true);
    const result = await requestBookingLinkEmail(address);
    setSending(false);
    if (result.kind === "sent") setSent(true);
    else if (result.kind === "invalid") setProblem("Please enter the email address you booked with.");
    else setProblem("We couldn't send the link. Please try again in a moment.");
  }

  if (sent) {
    return (
      <div className="mt-6">
        <Notice tone="success" role="status" title={FIND_BOOKING_SENT}>
          It can take a few minutes. If you don&apos;t see it, look in your spam folder. Each link opens your booking once.
        </Notice>
      </div>
    );
  }

  return (
    <form onSubmit={(event) => void submit(event)} noValidate className="mt-6">
      {problem ? (
        <div ref={alertBox} tabIndex={-1} role="alert" className="mb-4 outline-none">
          <Notice tone="danger" title={problem} />
        </div>
      ) : null}
      <label className={BOOKING_FIELD_LABEL_CLASS_V1}>
        Email address you booked with
        <input
          type="email"
          name="email"
          autoComplete="email"
          inputMode="email"
          required
          maxLength={FIND_BOOKING_EMAIL_MAX_LENGTH}
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          aria-invalid={problem ? true : undefined}
          className={BOOKING_FIELD_INPUT_CLASS_V1}
        />
      </label>
      <button type="submit" disabled={sending} aria-busy={sending || undefined} className={buttonClass("primary", "mt-5 w-full sm:w-auto")}>
        {sending ? "Sending…" : submitLabel}
      </button>
    </form>
  );
}
