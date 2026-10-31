import { HandIcon, type HandIconName } from "./HandIcon";
import { ButtonLink } from "./ui";

/** The kind of booking on the return URL (`?type=instant|approval`). Anything else, or nothing, is the neutral page. */
export type BookingReturnType = "instant" | "approval";

export function readReturnType(value: string | string[] | undefined): BookingReturnType | null {
  return value === "instant" || value === "approval" ? value : null;
}

type Step = { icon: HandIconName; title: string; text: string };

/**
 * What happens after payment, for both senders: NIHO (its own bookings) and this site (experiences it sells, #285 slice 5;
 * its email links to the guest's booking page since slice 6, as NIHO's links to its own).
 * The confirmation, the booking status and the emails belong to whichever confirmed the payment, so the words promise only
 * what both do and name neither. This page never says a booking is complete or paid (a return URL proves nothing). It only
 * says what to expect next, and its wording may follow the kind of booking (a fixed word on the URL, never free text, so
 * nobody can put their own wording on this page).
 */
export function BookingReturn({ type, showReview }: { type: BookingReturnType | null; showReview: boolean }) {
  const approval = type === "approval";
  const eyebrow = type ? "thank you" : "almost there";
  const heading = approval ? "The host will review your request" : type ? "Check your email for your booking" : "Check your email";
  const lead = approval
    ? "You are charged only if they accept. We email you either way."
    : type
      ? "Your confirmation comes by email once your payment goes through."
      : "We email you about your booking. If the host needs to approve your request, the email says so.";
  const steps: Step[] = [
    { icon: "mail", title: approval ? "An email about your request" : "Your confirmation email", text: approval ? "It tells you the request is with the host. Another follows when they answer." : "The experience, the date and time, your group, what you paid and a link to your booking." },
    { icon: "pin", title: "Meeting details", text: "Where to meet reaches you before the day." },
    { icon: "cal", title: "Meet your host", text: "On the day, meet your host where the meeting details say." },
    ...(showReview ? [{ icon: "chat" as const, title: "Share how it went", text: "After the experience, we ask how it was." }] : []),
  ];

  return (
    <div className="container-page max-w-2xl py-12">
      <p className="hand text-[1.75rem]">{eyebrow}</p>
      <h1 className="mt-1 text-3xl">{heading}</h1>
      <p className="mt-3 text-ink-soft">{lead}</p>
      <h2 className="mt-9 font-sans text-sm font-extrabold tracking-[0.04em] text-muted uppercase">What happens next</h2>
      <ol className="mt-4">
        {steps.map((step, index) => (
          <li key={step.title} className="relative flex gap-4 pb-6 last:pb-0">
            {index < steps.length - 1 ? <span aria-hidden className="absolute top-11 bottom-0 left-[19px] border-l-2 border-dashed border-line-strong" /> : null}
            <span className="grid size-10 shrink-0 place-items-center rounded-full bg-leaf-pale">
              <HandIcon name={step.icon} className="size-6 text-moss" />
            </span>
            <div className="min-w-0 pt-1">
              <b className="block font-extrabold">{step.title}</b>
              <span className="block text-[0.9375rem] text-ink-soft">{step.text}</span>
            </div>
          </li>
        ))}
      </ol>
      <p className="mt-8 text-sm text-muted">This page can&apos;t show your booking status. The email you get from us does.</p>
      <div className="mt-6 flex flex-wrap gap-3">
        <ButtonLink href="/help">Didn&apos;t get the email?</ButtonLink>
        <ButtonLink href="/experiences" variant="secondary">Browse experiences</ButtonLink>
      </div>
    </div>
  );
}
