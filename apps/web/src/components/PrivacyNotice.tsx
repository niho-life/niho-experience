import type { ReactNode } from "react";
import { AnalyticsPrivacyControl } from "./AnalyticsPrivacyControl";
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
 * The traveler privacy notice for bookings made on this site and questions asked here (#285, owner decision 2026-10-31), and
 * for travelers who booked through a partner site (OTA) whose details the site sends us (#194, owner decision 2026-11-01).
 * It says what the code does and nothing more (docs/guest-booking.md, docs/guest-questions.md): the wording is for the owner to
 * review before production. `policyUrl` is NIHO's privacy policy (EXPERIENCE_PRIVACY_POLICY_URL); empty leaves the link out.
 */
export function PrivacyNotice({ policyUrl, analytics = false, inquiry = false }: { policyUrl: string; analytics?: boolean; inquiry?: boolean }) {
  return (
    <div className="container-page max-w-2xl py-10 sm:py-16">
      <p className="eyebrow">How we handle your details</p>
      <h1 className="mt-2 text-4xl sm:text-5xl">Privacy</h1>
      <p className="mt-4 text-ink-soft">This page is about bookings you make, and questions you send to a host, on this site, and about bookings made through our partner sites.</p>
      <div className="mt-8 divide-y divide-line">
        <Section id="privacy-keep" title="What we keep">
          <p>
            When you book: your name, your email address, your phone number if you give one, your note to the host, your answers to the booking
            questions, the booking itself (date, party size and amount) and your messages with the host. If the link you came from carried
            campaign tags, we keep those too.
          </p>
          <p>When you ask a host a question before booking: your name, your email address and your messages.</p>
        </Section>
        <Section id="privacy-partners" title="If you booked through a partner site">
          <p>
            If you booked through a partner site (Airbnb, GetYourGuide, Viator, Jalan and others), we receive your name, number of guests, email
            address, phone number, language and notes from that site. We use them to run your experience and to contact you about it, and we keep them
            for one year after the experience.
          </p>
        </Section>
        {inquiry ? (
          <Section id="privacy-inquiry" title="If you send us an inquiry">
            <p>
              When you send an inquiry about a school or company visit, a group, or listing an experience (the inquiry form), we keep your name, your email
              address, your message, anything optional you fill in (such as your organisation, purpose, group size, dates, venue, budget or how it would
              be paid) and the page you came from. If the link you came from carried campaign tags, we keep those too.
            </p>
            <p>
              We use it only to reply to you and to plan with you. Only the NIHO office sees it: hosts do not, and nothing is sent to analytics. We send
              you one email to confirm we received it, through our email provider. Sending an inquiry does not book or reserve anything.
            </p>
            <p>We delete an inquiry one year after we close it, and sooner if you ask us to.</p>
          </Section>
        ) : null}
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
          {analytics ? (
            <p>
              If you allow Google Analytics, it sets a first-party analytics cookie for this site only. It expires after 60 days. We save your choice in
              this browser for up to 180 days so we can remember whether you allowed or rejected analytics. You can change or withdraw your choice at any
              time using the settings below. Your choice does not affect booking.
            </p>
          ) : null}
          <p>Your booking page and the reply page don&apos;t send anything to our analytics.</p>
        </Section>
        {analytics ? (
          <Section id="privacy-analytics" title="Optional visit counts">
            <p>
              Google Analytics (Google LLC) is optional and stays off unless you choose “Allow analytics”. If you allow it, your browser sends Google the
              public page path, permitted campaign tags, a general page title, the origin of the site you came from, a pseudonymous browser identifier and
              session details from the first-party analytics cookie, and browser and device details. Google may also automatically receive standard events
              such as first_visit and session_start for visit and session counts. Google receives the IP address used to make the connection and says it does
              not log or store IP addresses. We use this only to understand visits to selected public pages and improve those pages.
            </p>
            <p>
              We do not send your name, email address, messages, booking details or payment information, and do not configure custom booking or funnel events.
              Booking, member, host and admin pages are excluded. Before you allow it, no Google tag loads. After you reject or withdraw consent, the tag is
              disabled and no analytics is sent. If your browser sends a Do Not Track signal, analytics stays off.
              Google Signals, User-ID and ad personalization are off. Google’s user-level and event-level data retention is set to 2 months; standard
              aggregated reports are not removed by that setting.
            </p>
            <p><AnalyticsPrivacyControl /></p>
          </Section>
        ) : null}
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
