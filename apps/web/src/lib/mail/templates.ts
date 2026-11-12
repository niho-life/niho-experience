import type { BookingConfirmationEmail, BookingLinkEmail, BookingMeetingGuideEmail, BookingNoticeEmail, ClaimedBookingMessage, ClaimedSupportBookingMessage, ManagedGuestMailEmail, ManagedOperationsMailEmail, ReviewInvitationEmail } from "@niho-experience/experience-store";
import { DATE_LONG, DATE_SHORT, REFUND_TIMING, calendarDate, cancellationTermsWords, cancelledBy, money, party, zoneName } from "@/lib/booking-words";

/**
 * The emails guests get from this site (#285 slice 5): plain English, a text part and a minimal HTML part
 * of the same words. No images, tracking or remote resources; every link is absolute. The guest's name
 * appears in the greeting only; nothing else personal beyond what the email is about.
 */
export interface RenderedMail {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  readonly attachments?: readonly { readonly filename: string; readonly content: Uint8Array; readonly contentType: "image/jpeg"; readonly cid: string }[];
}

export type MailBlock =
  | { readonly kind: "p"; readonly text: string }
  | { readonly kind: "quote"; readonly text: string }
  | { readonly kind: "facts"; readonly rows: readonly (readonly [string, string])[] }
  | { readonly kind: "link"; readonly lead: string; readonly label: string; readonly href: string }
  | { readonly kind: "image"; readonly cid: string; readonly alt: string };

type Block = MailBlock;

/** A subject is a header and a name sits in a sentence: one line, no control characters. */
export function oneLine(value: string): string {
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
      case "image":
        return `[${block.alt}]`;
    }
  }).join("\n\n")}\n`;
}

const P = 'style="margin:0 0 16px"';

function renderHtml(subject: string, blocks: readonly Block[], lang: "en" | "ja"): string {
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
      case "image":
        return `<p ${P}><img src="cid:${escapeHtml(block.cid)}" alt="${escapeHtml(block.alt)}" style="display:block;max-width:100%;height:auto;border-radius:12px"></p>`;
    }
  }).join("\n");
  return `<!doctype html>
<html lang="${lang}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:24px 16px;background:#ffffff;color:#1f2a1c;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:16px;line-height:1.5">
<div style="max-width:560px;margin:0 auto">
${content}
</div>
</body>
</html>
`;
}

/** One email: the subject on one line, then a text part and an HTML part of the same blocks. Hosts' emails are Japanese (#194). */
export function mail(subject: string, blocks: readonly MailBlock[], lang: "en" | "ja" = "en"): RenderedMail {
  const line = oneLine(subject);
  return { subject: line, text: renderText(blocks), html: renderHtml(line, blocks, lang) };
}

/** `https://experience.example` + a path; the site origin is checked at start-up (resolve-config). */
export function absolute(siteUrl: string, path: string): string {
  return new URL(path, `${siteUrl.replace(/\/+$/, "")}/`).href;
}

/** The token is issued immediately before sending and stays in the URL fragment. */
export function reviewInvitationEmail(email: ReviewInvitationEmail, options: { readonly siteUrl: string; readonly token: string }): RenderedMail {
  const experience = oneLine(email.experienceTitle);
  const link = `${absolute(options.siteUrl, "/reviews/write")}#t=${encodeURIComponent(options.token)}`;
  return mail(`Thank you for joining ${experience}`, [
    { kind: "p", text: `Hi ${oneLine(email.guestName)},` },
    { kind: "p", text: `Thank you for joining ${experience}. We hope you enjoyed your experience.` },
    { kind: "p", text: "If you would like to share how it went, you can write one public review. Your private note to the host will stay private." },
    { kind: "link", lead: "Write your review:", label: "Write a review", href: link },
  ]);
}

/** Private location details for a confirmed booking. The photo is embedded as an attachment, never a public URL. */
export function bookingMeetingGuideEmail(
  email: BookingMeetingGuideEmail,
  options: { readonly siteUrl: string; readonly bookingPageGrant: string; readonly photo: Uint8Array },
): RenderedMail {
  const experience = oneLine(email.experienceTitle);
  const cid = "niho-meeting-place-photo";
  const blocks: MailBlock[] = [
    { kind: "p", text: `Hi ${oneLine(email.guestName)},` },
    { kind: "p", text: `Here are the meeting details for ${experience}.` },
    { kind: "facts", rows: [["Date", calendarDate(email.localDate, DATE_LONG)], ["Time", `${email.localStartTime} ${zoneName(email.timeZone)}`], ["Meeting place", oneLine(email.collectionOverview)]] },
    { kind: "image", cid, alt: "The outside of the meeting place" },
    { kind: "p", text: oneLine(email.address) },
    ...(email.accessInstructions ? [{ kind: "p", text: body(email.accessInstructions) } as const] : []),
    ...(email.entranceInstructions ? [{ kind: "p", text: body(email.entranceInstructions) } as const] : []),
    ...(email.mapUrl ? [{ kind: "link", lead: "Open the meeting place on the map:", label: "Open map", href: email.mapUrl } as const] : []),
    ...(email.itemsToBring.length ? [{ kind: "facts", rows: [["What to bring", email.itemsToBring.map(oneLine).join(", ")]] } as const] : []),
    ...(email.weatherPlan ? [{ kind: "p", text: `Weather plan: ${body(email.weatherPlan)}` } as const] : []),
    { kind: "link", lead: "If you are running late or need help finding the meeting place, message your host from your booking page:", label: "Open your booking", href: `${absolute(options.siteUrl, "/bookings/open")}#g=${encodeURIComponent(options.bookingPageGrant)}` },
  ];
  return {
    ...mail(`Meeting details: ${experience}, ${calendarDate(email.localDate, DATE_SHORT)} ${email.localStartTime}`, blocks),
    attachments: [{ filename: "meeting-place.jpg", content: options.photo, contentType: "image/jpeg", cid }],
  };
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
  const managed = email.managedSeller;
  const provider = managed?.providerDisplayName ? oneLine(managed.providerDisplayName) : null;
  const time = `${email.localStartTime} ${zoneName(email.timeZone)}`;
  const policy = email.totalAmount === 0
    ? "You can cancel this free booking any time before the experience ends."
    : cancellationTermsWords(email, options.now);
  const grant = options.bookingPageGrant;
  return mail(`Your booking is confirmed: ${experience}, ${calendarDate(email.localDate, DATE_SHORT)} ${email.localStartTime}`, [
    { kind: "p", text: `Hi ${oneLine(email.guestName)},` },
    { kind: "p", text: email.totalAmount === 0 ? "Your free booking is confirmed. No payment is due." : "Your booking is confirmed and paid. Here are the details." },
    {
      kind: "facts",
      rows: [
        ["Experience", experience],
        ["Date", calendarDate(email.localDate, DATE_LONG)],
        ["Time", time],
        ["Guests", party(email.adultCount, email.childCount)],
        [email.totalAmount === 0 ? "Total" : "Total paid", email.totalAmount === 0 ? "Free" : money(email.totalAmount, email.currency)],
        ...(managed ? [["Seller", oneLine(managed.displayName)] as const, ...(provider ? [["Host", provider] as const] : [])] : [["Host", host] as const]),
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
    { kind: "p", text: `${managed ? "NIHO support" : host} will share the meeting details with you before the day.` },
    { kind: "link", lead: "The experience page:", label: experience, href: absolute(options.siteUrl, `${email.japaneseOnly ? "/ja" : ""}/experiences/${encodeURIComponent(email.experienceSlug)}`) },
    { kind: "p", text: "Questions, or need to change or cancel? Reply to this email and NIHO support will help." },
  ]);
}

/**
 * "{Host} sent you a message about your booking: {experience}, {date} {time}" (#285 slice 6b): the host's English
 * (never the Japanese they wrote) and, with a grant, a link to the booking page, where the guest answers. Without one
 * (the page is off, or can no longer be opened) the email says replying to it reaches NIHO support.
 */
export function bookingMessageEmail(
  message: Pick<ClaimedBookingMessage, "guestName" | "hostDisplayName" | "experienceTitle" | "english" | "publicBookingId" | "localDate" | "localStartTime" | "timeZone">,
  options: { readonly siteUrl: string; readonly bookingPageGrant: string | null },
): RenderedMail {
  const host = oneLine(message.hostDisplayName);
  const experience = oneLine(message.experienceTitle);
  const grant = options.bookingPageGrant;
  return mail(`${host} sent you a message about your booking: ${experience}, ${calendarDate(message.localDate, DATE_SHORT)} ${message.localStartTime}`, [
    { kind: "p", text: `Hi ${oneLine(message.guestName)},` },
    { kind: "p", text: `${host} sent you a message about your booking:` },
    { kind: "quote", text: body(message.english) },
    {
      kind: "facts",
      rows: [
        ["Experience", experience],
        ["Date", calendarDate(message.localDate, DATE_LONG)],
        ["Time", `${message.localStartTime} ${zoneName(message.timeZone)}`],
        ["Booking reference", message.publicBookingId],
      ],
    },
    ...(grant
      ? [{
          kind: "link",
          lead: `To answer ${host}, open your booking and write to them there. The link works once and opens the booking on one device, so please don't forward it. You can ask for a new link any time at ${absolute(options.siteUrl, "/bookings")}`,
          label: "View your booking",
          href: bookingPageLink(options.siteUrl, grant),
        } as const]
      : []),
    { kind: "p", text: `Replying to this email reaches NIHO support, not ${host}.` },
  ]);
}

/** A guest-facing Admin message clearly marked as NIHO support, sent through the booking message outbox. */
export function supportBookingMessageEmail(
  message: Pick<ClaimedSupportBookingMessage, "guestName" | "experienceTitle" | "english" | "publicBookingId" | "localDate" | "localStartTime" | "timeZone">,
  options: { readonly siteUrl: string; readonly bookingPageGrant: string | null },
): RenderedMail {
  const experience = oneLine(message.experienceTitle);
  const grant = options.bookingPageGrant;
  return mail(`NIHO support sent you a message about your booking: ${experience}, ${calendarDate(message.localDate, DATE_SHORT)} ${message.localStartTime}`, [
    { kind: "p", text: `Hi ${oneLine(message.guestName)},` },
    { kind: "p", text: "NIHO support sent you a message about your booking:" },
    { kind: "quote", text: body(message.english) },
    { kind: "facts", rows: [["Experience", experience], ["Date", calendarDate(message.localDate, DATE_LONG)], ["Time", `${message.localStartTime} ${zoneName(message.timeZone)}`], ["Booking reference", message.publicBookingId]] },
    ...(grant ? [{ kind: "link", lead: "Open your booking to continue the conversation with NIHO support. This link works once and opens the booking on one device, so please don't forward it.", label: "View your booking", href: bookingPageLink(options.siteUrl, grant) } as const] : []),
    { kind: "p", text: "Replying to this email reaches NIHO support, not your provider." },
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
      : email.totalAmount === 0 ? "No payment was required, so no refund is due." : "No refund is due for this booking.";
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

const DATE_JA = new Intl.DateTimeFormat("ja-JP", { timeZone: "UTC", dateStyle: "full" });

function instantInLocale(value: string, locale: "en" | "ja"): string {
  return new Intl.DateTimeFormat(locale === "ja" ? "ja-JP" : "en-US", {
    timeZone: "Asia/Tokyo", dateStyle: "long", timeStyle: "short",
  }).format(new Date(value)) + (locale === "ja" ? "（日本時間）" : " (Japan time)");
}

/** MANAGED_20 request lifecycle mail. Checkout URLs exist only in this in-memory render call. */
export function managedGuestBookingEmail(
  email: ManagedGuestMailEmail,
  options: { readonly checkoutUrl?: string; readonly checkoutExpiresAtUtc?: string },
): RenderedMail {
  const experience = oneLine(email.experienceTitle);
  const ja = email.guestLanguage === "JA";
  const language = ja ? "ja" : "en";
  const facts: MailBlock = {
    kind: "facts",
    rows: ja
      ? [["体験", experience], ["日付", calendarDate(email.localDate, DATE_JA)], ["時刻", `${email.localStartTime}（${email.timeZone === "Asia/Tokyo" ? "日本時間" : email.timeZone}）`], ["予約番号", email.publicBookingId]]
      : [["Experience", experience], ["Date", calendarDate(email.localDate, DATE_LONG)], ["Time", `${email.localStartTime} ${zoneName(email.timeZone)}`], ["Booking reference", email.publicBookingId]],
  };
  if (email.kind === "REQUEST_RECEIVED") {
    return mail(ja ? `予約リクエストを受け付けました：${experience}` : `We received your booking request: ${experience}`, [
      { kind: "p", text: ja ? `${oneLine(email.guestName)} 様` : `Hi ${oneLine(email.guestName)},` },
      { kind: "p", text: ja ? "予約リクエストを受け付けました。この時点ではお支払いは発生していません。NIHO事務局が確認後、結果をメールでお知らせします。" : "We received your booking request. No payment has been taken. NIHO will review it and email you with the result." },
      facts,
      { kind: "p", text: ja ? `このリクエストの期限は ${instantInLocale(email.holdExpiresAtUtc, language)} です。` : `This request is held until ${instantInLocale(email.holdExpiresAtUtc, language)}.` },
    ], language);
  }
  if (email.kind === "PAYMENT_READY") {
    if (!options.checkoutUrl || !options.checkoutExpiresAtUtc) throw new Error("A managed payment email needs a verified Checkout URL and expiry.");
    return mail(ja ? `予約が承認されました：${experience}のお支払い` : `Your request is approved: pay for ${experience}`, [
      { kind: "p", text: ja ? `${oneLine(email.guestName)} 様` : `Hi ${oneLine(email.guestName)},` },
      { kind: "p", text: ja ? "予約リクエストが承認されました。下のStripe決済ページから期限までにお支払いください。お支払い完了後に予約が確定します。" : "Your booking request is approved. Please pay on Stripe before the deadline below. Your booking is confirmed after payment succeeds." },
      facts,
      { kind: "p", text: ja ? `支払期限：${instantInLocale(options.checkoutExpiresAtUtc, language)}` : `Payment deadline: ${instantInLocale(options.checkoutExpiresAtUtc, language)}` },
      { kind: "link", lead: ja ? "安全なStripe決済ページ：" : "Secure Stripe payment page:", label: ja ? "支払いへ進む" : "Pay now", href: options.checkoutUrl },
      { kind: "p", text: ja ? "このリンクを転送しないでください。ご不明点はこのメールへ返信してください。" : "Please do not forward this link. Reply to this email if you need help." },
    ], language);
  }
  if (email.kind === "REQUEST_DECLINED") {
    return mail(ja ? `予約リクエストをお受けできませんでした：${experience}` : `We couldn't accept your booking request: ${experience}`, [
      { kind: "p", text: ja ? `${oneLine(email.guestName)} 様` : `Hi ${oneLine(email.guestName)},` },
      { kind: "p", text: ja ? "申し訳ありませんが、今回は予約リクエストをお受けできませんでした。お支払いは発生していません。" : "We're sorry, but we couldn't accept this booking request. No payment was taken." },
      facts,
      { kind: "p", text: ja ? "別の日程をご検討ください。ご不明点はこのメールへ返信してください。" : "Please consider another date. Reply to this email if you need help." },
    ], language);
  }
  if (email.kind === "PAYMENT_FAILED") {
    return mail(ja ? `お支払いを完了できませんでした：${experience}` : `Your payment didn't go through: ${experience}`, [
      { kind: "p", text: ja ? `${oneLine(email.guestName)} 様` : `Hi ${oneLine(email.guestName)},` },
      { kind: "p", text: ja ? "お支払いを完了できず、予約は成立しませんでした。" : "Your payment didn't go through and your booking couldn't be confirmed." },
      facts,
      { kind: "p", text: ja ? "ご参加をご希望の場合は、体験ページから改めてお申し込みください。" : "If you would still like to join, please make a new request from the experience page." },
    ], language);
  }
  return mail(ja ? `予約リクエストの期限が切れました：${experience}` : `Your booking request expired: ${experience}`, [
    { kind: "p", text: ja ? `${oneLine(email.guestName)} 様` : `Hi ${oneLine(email.guestName)},` },
    { kind: "p", text: ja ? "期限までに予約を確定できなかったため、確保していた在庫を戻しました。お支払いは完了していません。" : "The request could not be confirmed before its deadline, so the held place was released. Payment was not completed." },
    facts,
    { kind: "p", text: ja ? "参加をご希望の場合は、体験ページから改めてお申し込みください。" : "If you would still like to join, please make a new request from the experience page." },
  ], language);
}

/** NIHO office/provider copy: deliberately contains no guest identity or guest/payment access link. */
export function managedOperationsBookingEmail(email: ManagedOperationsMailEmail, siteUrl: string): RenderedMail {
  const experience = oneLine(email.experienceTitle);
  const event = email.kind === "NEW_REQUEST" ? "新しい申込" : email.kind === "CONFIRMED" ? "予約確定" : "予約取消";
  const audience = email.role === "OFFICE" ? "NIHO事務局" : "体験提供者";
  return mail(`[${audience}] ${event}：${experience}`, [
    { kind: "facts", rows: [
      ["体験", experience],
      ["日付", calendarDate(email.localDate, DATE_JA)],
      ["時刻", `${email.localStartTime}（${email.timeZone === "Asia/Tokyo" ? "日本時間" : email.timeZone}）`],
      ["人数", `大人${email.adultCount}人${email.childCount ? `、子ども${email.childCount}人` : ""}`],
      ["予約番号", email.publicBookingId],
    ] },
    ...(email.role === "OFFICE" ? [
      { kind: "link", lead: "事務局で対応するには、管理画面を開いてください。", label: "予約管理を開く", href: absolute(siteUrl, "/admin/site-bookings") } as const,
    ] : []),
  ], "ja");
}
