import type { ReactNode } from "react";
import { LocalizedLink as Link } from "./LocalizedLink";

const LINK = "font-bold text-moss underline underline-offset-4";

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="py-6">
      <h2 id={id} className="text-2xl">{title}</h2>
      <div className="mt-2 space-y-3 text-ink-soft">{children}</div>
    </section>
  );
}

function List({ children }: { children: ReactNode }) {
  return <ul className="list-disc space-y-2 pl-5">{children}</ul>;
}

/**
 * The traveler privacy notice for bookings made on this site and questions asked here (#285, owner decision 2026-10-31).
 * It says what the code does and nothing more (docs/guest-booking.md, docs/guest-questions.md): the wording is for the owner to
 * review before production. `policyUrl` is NIHO's privacy policy (EXPERIENCE_PRIVACY_POLICY_URL); empty leaves the link out.
 */
export function PrivacyNotice({ policyUrl }: { policyUrl: string }) {
  return (
    <div className="container-page max-w-2xl py-10 sm:py-16">
      <p className="eyebrow">How we handle your details</p>
      <h1 className="mt-2 text-4xl sm:text-5xl">Privacy</h1>
      <p className="mt-4 text-ink-soft">This page is about bookings you make, and questions you send to a host, on this site.</p>
      <div className="mt-8 divide-y divide-line">
        <Section id="privacy-keep" title="What we keep">
          <p>
            When you book: your name, your email address, your phone number if you give one, your note to the host, your answers to the booking
            questions, the booking itself (date, party size and amount) and your messages with the host. If the link you came from carried
            campaign tags, we keep those too.
          </p>
          <p>When you ask a host a question before booking: your name, your email address and your messages.</p>
        </Section>
        <Section id="privacy-why" title="Why we use it">
          <p>To run your booking, to send you booking emails, and to let the host prepare for your visit and reply to you.</p>
        </Section>
        <Section id="privacy-who" title="Who sees or handles it">
          <List>
            <li>
              <b className="text-ink">The host</b> sees your name, party size, language, note, answers and messages. Your phone number, if you gave one,
              appears only on the host&apos;s page for your date. The host never sees your email address.
            </li>
            <li>
              <b className="text-ink">Stripe</b> takes your payment. You enter your card details on Stripe&apos;s page, so we never see them. We pass your email
              address to Stripe to fill in its form.
            </li>
            <li>
              <b className="text-ink">Our email provider</b> delivers the booking emails we send you.
            </li>
            <li>
              <b className="text-ink">Anthropic</b>, the company behind Claude. When translation is used, it receives the text of your messages to translate them
              into Japanese for the host, and the text of the host&apos;s replies to help draft the English you read. We send only the message text, not your
              name, email address or booking details.
            </li>
            <li>
              <b className="text-ink">NIHO support</b> can open your booking when you ask for help, or when a payment, refund or cancellation needs attention.
            </li>
          </List>
        </Section>
        <Section id="privacy-time" title="How long we keep it">
          <List>
            <li>
              Your details and your messages with the host are deleted one year after the experience. For a cancelled booking, that is one year after the
              cancellation. We keep the booking&apos;s date, party size and amount, without your details.
            </li>
            <li>If a payment review, a refund or a cancellation request is still open, we keep them until it is settled.</li>
            <li>Questions you ask before booking are deleted one year after the last message.</li>
          </List>
        </Section>
        <Section id="privacy-cookies" title="Cookies">
          <p>
            Your booking page uses one strictly necessary cookie for each booking. It keeps that one booking open in your browser and can&apos;t be read by
            scripts on the page (HttpOnly). It lasts until 30 days after the experience at the latest, and sooner if you sign out or don&apos;t open the page
            for 30 days.
          </p>
          <p>Your booking page and the reply page don&apos;t send anything to our analytics.</p>
        </Section>
        <Section id="privacy-contact" title="Questions or requests">
          <p>
            To ask about your details, or to ask us to correct or delete them, reply to any booking email or go to{" "}
            <Link href="/help" className={LINK}>Booking help</Link>.
          </p>
          {policyUrl ? (
            <p>
              More about how NIHO handles personal information:{" "}
              <a href={policyUrl} target="_blank" rel="noopener noreferrer" className={LINK}>NIHO privacy policy</a>.
            </p>
          ) : null}
        </Section>
      </div>
    </div>
  );
}
