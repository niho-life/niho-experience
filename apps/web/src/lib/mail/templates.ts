import type { BookingConfirmationEmail, BookingLinkEmail, BookingNoticeEmail } from "@niho-experience/experience-store";
import { DATE_LONG, DATE_SHORT, REFUND_TIMING, calendarDate, cancellationWords, cancelledBy, money, party, zoneName } from "@/lib/booking-words";

/**
 * The emails guests get from this site (#285 slice 5): plain English, a text part and a minimal HTML part
 * of the same words. No images, tracking or remote resources; every link is absolute. The guest's name
 * appears in the greeting only; nothing else personal beyond what the email is about.
 */
export interface RenderedMail {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

type Block =
  | { readonly kind: "p"; readonly text: string }
  | { readonly kind: "quote"; readonly text: string }
  | { readonly kind: "facts"; readonly rows: readonly (readonly [string, string])[] }
  | { readonly kind: "link"; readonly lead: string; readonly label: string; readonly href: string };

/** A subject is a header and a name sits in a sentence: one line, no control characters. */
function oneLine(value: string): string {
  return value.replace(/[\u0000-\u001F\u007F\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
}

/** A message body: line breaks kept as \n, other control characters dropped. */
function body(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, "").trim();
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

const multiline = (value: string) => escapeHtml(value).replaceAll("\n", "<br>");

function renderText(blocks: readonly Block[]): string {
  return `${blocks.map((block) => {
    switch (block.kind) {
      case "p":
      case "quote":
        return block.text;
      case "facts":
        return block.rows.map(([label, value]) => `${label}: ${value}`).join("\n");
      case "link":
        return `${block.lead}\n${block.href}`;
    }
  }).join("\n\n")}\n`;
}

const P = 'style="margin:0 0 16px"';

function renderHtml(subject: string, blocks: readonly Block[]): string {
  const content = blocks.map((block) => {
    switch (block.kind) {
      case "p":
        return `<p ${P}>${multiline(block.text)}</p>`;
      case "quote":
        return `<blockquote style="margin:0 0 16px;padding:8px 16px;border-left:4px solid #c9d6c3;color:#2f3a2c">${multiline(block.text)}</blockquote>`;
      case "facts":
        return `<table role="presentation" style="margin:0 0 16px;border-collapse:collapse">${block.rows.map(([label, value]) =>
          `<tr><th scope="row" style="padding:2px 16px 2px 0;text-align:left;vertical-align:top;font-weight:600">${escapeHtml(label)}</th><td style="padding:2px 0">${escapeHtml(value)}</td></tr>`).join("")}</table>`;
      case "link":
        return `<p ${P}>${escapeHtml(block.lead)}<br><a href="${escapeHtml(block.href)}" style="color:#2f5d2a">${escapeHtml(block.label)}</a></p>`;
    }
  }).join("\n");
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:24px 16px;background:#ffffff;color:#1f2a1c;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:16px;line-height:1.5">
<div style="max-width:560px;margin:0 auto">
${content}
</div>
</body>
</html>
`;
}

function mail(subject: string, blocks: readonly Block[]): RenderedMail {
  const line = oneLine(subject);
  return { subject: line, text: renderText(blocks), html: renderHtml(line, blocks) };
}

/** `https://experience.example` + a path; the site origin is checked at start-up (resolve-config). */
function absolute(siteUrl: string, path: string): string {
  return new URL(path, `${siteUrl.replace(/\/+$/, "")}/`).href;
}

export interface QuestionReplyMailInput {
  /** SITE_URL. */
  readonly siteUrl: string;
  readonly guestName: string;
  readonly hostName: string;
  readonly experienceTitle: string;
  /** The host's English. */
  readonly reply: string;
  /** For `/questions/reply#t=<token>`: placed in the fragment only, never in a path or query. */
  readonly replyToken: string;
  readonly linkTtlDays: number;
}

/** "{Host} replied to your question about {experience}", with the reply and the one-time link to answer. */
export function questionReplyEmail(input: QuestionReplyMailInput): RenderedMail {
  const host = oneLine(input.hostName);
  const experience = oneLine(input.experienceTitle);
  const link = `${absolute(input.siteUrl, "/questions/reply")}#t=${encodeURIComponent(input.replyToken)}`;
  return mail(`${host} replied to your question about ${experience}`, [
    { kind: "p", text: `Hi ${oneLine(input.guestName)},` },
    { kind: "p", text: `${host} replied to your question about ${experience}:` },
    { kind: "quote", text: body(input.reply) },
    { kind: "link", lead: `To answer ${host}, open this link. You can answer once with it, within ${input.linkTtlDays} days.`, label: `Answer ${host}`, href: link },
    { kind: "p", text: `Replying to this email reaches NIHO support, not ${host}.` },
  ]);
}

/** `{SITE_URL}/bookings/open#g=<grant>`: the one-time grant is placed in the fragment only, never in a path or query. */
function bookingPageLink(siteUrl: string, grant: string): string {
  return `${absolute(siteUrl, "/bookings/open")}#g=${encodeURIComponent(grant)}`;
}

/**
 * "Your booking is confirmed: {experience}, {date} {time}". The meeting point is not included (it is NIHO
 * content today): the email says the host shares the meeting details and that replying reaches NIHO support.
 * With a grant (#285 slice 6) it links to the guest's booking page; without one (the page is off) it does not.
 */
export function bookingConfirmationEmail(
  email: BookingConfirmationEmail,
  options: { readonly siteUrl: string; readonly now: Date; readonly bookingPageGrant?: string | null },
): RenderedMail {
  const experience = oneLine(email.experienceTitle);
  const host = oneLine(email.hostDisplayName);
  const time = `${email.localStartTime} ${zoneName(email.timeZone)}`;
  const policy = cancellationWords(email, options.now);
  const grant = options.bookingPageGrant;
  return mail(`Your booking is confirmed: ${experience}, ${calendarDate(email.localDate, DATE_SHORT)} ${email.localStartTime}`, [
    { kind: "p", text: `Hi ${oneLine(email.guestName)},` },
    { kind: "p", text: "Your booking is confirmed and paid. Here are the details." },
    {
      kind: "facts",
      rows: [
        ["Experience", experience],
        ["Date", calendarDate(email.localDate, DATE_LONG)],
        ["Time", time],
        ["Guests", party(email.adultCount, email.childCount)],
        ["Total paid", money(email.totalAmount, email.currency)],
        ["Host", host],
        ["Booking reference", email.publicBookingId],
      ],
    },
    ...(policy ? [{ kind: "p", text: policy } as const] : []),
    ...(grant
      ? [{
          kind: "link",
          lead: `See your booking on our site. The link works once and opens the booking on one device, so please don't forward it. You can ask for a new link any time at ${absolute(options.siteUrl, "/bookings")}`,
          label: "View your booking",
          href: bookingPageLink(options.siteUrl, grant),
        } as const]
      : []),
    { kind: "p", text: `${host} will share the meeting details with you before the day.` },
    { kind: "link", lead: "The experience page:", label: experience, href: absolute(options.siteUrl, `/experiences/${encodeURIComponent(email.experienceSlug)}`) },
    { kind: "p", text: "Questions, or need to change or cancel? Reply to this email and NIHO support will help." },
  ]);
}

/**
 * "Your booking link: {experience}, {date} {time}" for "Find your booking" (#285 slice 6): the booking it is for and a
 * one-time link to its page. The guest asked for it on the site; someone else may have typed their address, so the
 * email says it can be ignored.
 */
export function bookingLinkEmail(email: BookingLinkEmail, options: { readonly siteUrl: string; readonly bookingPageGrant: string }): RenderedMail {
  const experience = oneLine(email.experienceTitle);
  return mail(`Your booking link: ${experience}, ${calendarDate(email.localDate, DATE_SHORT)} ${email.localStartTime}`, [
    { kind: "p", text: `Hi ${oneLine(email.guestName)},` },
    { kind: "p", text: "Here is the link to your booking that was asked for on NIHO Experience." },
    {
      kind: "facts",
      rows: [
        ["Experience", experience],
        ["Date", calendarDate(email.localDate, DATE_LONG)],
        ["Time", `${email.localStartTime} ${zoneName(email.timeZone)}`],
        ["Booking reference", email.publicBookingId],
      ],
    },
    {
      kind: "link",
      lead: `The link works once, for up to 30 days, and opens the booking on one device, so please don't forward it. You can ask for a new link any time at ${absolute(options.siteUrl, "/bookings")}`,
      label: "View your booking",
      href: bookingPageLink(options.siteUrl, options.bookingPageGrant),
    },
    { kind: "p", text: "If you didn't ask for this, you can ignore this email." },
    { kind: "p", text: "Questions? Reply to this email and NIHO support will help." },
  ]);
}

/**
 * The notices of 取消と返金 (#285 slice 7): the booking was cancelled (by the guest, the host or NIHO support, with the
 * refund started), the refund is done, or support declined the guest's request to cancel (with support's words).
 * Each names the booking; a cancelled one says why in the fixed words of its reason, never the host's own note. A
 * refund is called done only in the email Stripe's confirmation triggers. With a grant, a link to the booking page.
 */
export function bookingNoticeEmail(email: BookingNoticeEmail, options: { readonly siteUrl: string; readonly bookingPageGrant?: string | null }): RenderedMail {
  const experience = oneLine(email.experienceTitle);
  const when = `${calendarDate(email.localDate, DATE_SHORT)} ${email.localStartTime}`;
  const facts: Block = {
    kind: "facts",
    rows: [
      ["Experience", experience],
      ["Date", calendarDate(email.localDate, DATE_LONG)],
      ["Time", `${email.localStartTime} ${zoneName(email.timeZone)}`],
      ["Booking reference", email.publicBookingId],
    ],
  };
  const grant = options.bookingPageGrant;
  const page: Block[] = grant
    ? [{ kind: "link", lead: "See your booking on our site. The link works once, so please don't forward it.", label: "View your booking", href: bookingPageLink(options.siteUrl, grant) }]
    : [];
  const greeting: Block = { kind: "p", text: `Hi ${oneLine(email.guestName)},` };
  if (email.kind === "CANCELLED") {
    const host = oneLine(email.hostDisplayName);
    const refund = email.refundAmount > 0
      ? `We've started a refund of ${money(email.refundAmount, email.currency)} to the card you paid with. We'll email you again when it's done.`
      : "No refund is due for this booking.";
    return mail(`Your booking is cancelled: ${experience}, ${when}`, [
      greeting,
      { kind: "p", text: cancelledBy({ cancelledBy: email.cancelledBy, cancellationReason: email.reason, hostDisplayName: host }) },
      facts,
      { kind: "p", text: refund },
      ...page,
      { kind: "p", text: "Questions? Reply to this email and NIHO support will help." },
    ]);
  }
  if (email.kind === "REFUNDED") {
    return mail(`Your refund is done: ${experience}, ${when}`, [
      greeting,
      { kind: "p", text: `We've refunded ${money(email.amount, email.currency)} to the card you paid with. ${REFUND_TIMING}` },
      facts,
      ...page,
      { kind: "p", text: "Questions? Reply to this email and NIHO support will help." },
    ]);
  }
  return mail(`About your request to cancel: ${experience}, ${when}`, [
    greeting,
    { kind: "p", text: "NIHO support looked at your request to cancel this booking. Your booking stays confirmed." },
    { kind: "quote", text: body(email.message) },
    facts,
    ...page,
    { kind: "p", text: "To reply, answer this email and NIHO support will help." },
  ]);
}
