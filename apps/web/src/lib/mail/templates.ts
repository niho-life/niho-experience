import type { BookingConfirmationEmail } from "@niho-experience/experience-store";

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

const DATE_LONG = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long", year: "numeric" });
const DATE_SHORT = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short", year: "numeric" });

/** A calendar date (YYYY-MM-DD) in words; the date itself, whatever the server's zone. */
function calendarDate(localDate: string, format: Intl.DateTimeFormat): string {
  const [year, month, day] = localDate.split("-").map(Number);
  return format.format(new Date(Date.UTC(year!, month! - 1, day!))).replace(",", "");
}

const zoneName = (timeZone: string) => (timeZone === "Asia/Tokyo" ? "Japan time" : timeZone);

/** "Fri 13 Nov, 10:00" for an instant in the experience's time zone. */
function zonedMoment(instant: number, timeZone: string): string {
  const date = new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short" }).format(instant).replace(",", "");
  const clock = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(instant);
  return `${date}, ${clock}`;
}

function money(amount: number, currency: string): string {
  const format = new Intl.NumberFormat("en-US", { style: "currency", currency });
  const digits = format.resolvedOptions().maximumFractionDigits ?? 0;
  return format.format(amount / 10 ** digits);
}

function party(adults: number, children: number): string {
  const parts = [
    ...(adults ? [`${adults} adult${adults === 1 ? "" : "s"}`] : []),
    ...(children ? [`${children} child${children === 1 ? "" : "ren"}`] : []),
  ];
  return parts.join(", ");
}

const HOURS: Readonly<Record<string, number>> = { FREE_UNTIL_24H: 24, FREE_UNTIL_48H: 48 };

/** The policy fixed at booking, in plain words, with the moment free cancellation ends. */
function cancellationWords(email: BookingConfirmationEmail, now: Date): string | null {
  if (email.cancellationPolicy === null) return null;
  if (email.cancellationPolicy === "NONE") return "This booking is non-refundable.";
  const hours = HOURS[email.cancellationPolicy]!;
  const deadline = Date.parse(email.startUtc) - hours * 3_600_000;
  if (!Number.isFinite(deadline) || deadline <= now.getTime()) {
    return `Free cancellation ends ${hours} hours before the start, so this booking is now non-refundable.`;
  }
  return `Free cancellation until ${zonedMoment(deadline, email.timeZone)} ${zoneName(email.timeZone)} (${hours} hours before the start). After that, the booking is non-refundable.`;
}

/**
 * "Your booking is confirmed: {experience}, {date} {time}". The meeting point is not included (it is NIHO
 * content today): the email says the host shares the meeting details and that replying reaches NIHO support.
 */
export function bookingConfirmationEmail(email: BookingConfirmationEmail, options: { readonly siteUrl: string; readonly now: Date }): RenderedMail {
  const experience = oneLine(email.experienceTitle);
  const host = oneLine(email.hostDisplayName);
  const time = `${email.localStartTime} ${zoneName(email.timeZone)}`;
  const policy = cancellationWords(email, options.now);
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
    { kind: "p", text: `${host} will share the meeting details with you before the day.` },
    { kind: "link", lead: "The experience page:", label: experience, href: absolute(options.siteUrl, `/experiences/${encodeURIComponent(email.experienceSlug)}`) },
    { kind: "p", text: "Questions, or need to change or cancel? Reply to this email and NIHO support will help." },
  ]);
}
