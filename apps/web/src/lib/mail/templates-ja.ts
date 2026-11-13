import type { BookingConfirmationEmail, BookingLinkEmail, BookingMeetingGuideEmail, BookingNoticeEmail, ClaimedBookingMessage, ClaimedSupportBookingMessage, ReviewInvitationEmail } from "@niho-experience/experience-store";
import { REFUND_TIMING_JA, calendarDateJa, cancelledByJa, cancellationTermsWordsJa, moneyJa, partyJa, zoneNameJa } from "@/lib/booking-words-ja";
import { absolute, body, mail, oneLine, type MailBlock, type QuestionReplyMailInput, type RenderedMail } from "./templates";

/**
 * 日本語で申し込んだゲストへのメール（#59）。申込み時の表示言語（`booking_guests.guest_language`）が JA の予約は、
 * templates.ts の同名の関数からここへ回る。英語版と同じ事実・同じリンク・同じ条件で、言語だけが違う。
 *
 * 予約ページ（/bookings/…）・予約の照会・ホストへのメッセージ・レビューの投稿は v0 では英語のままなので、
 * そこへ案内するメールは、英語の画面になることと、日本語の連絡先（このメールへの返信＝NIHO事務局）を添える。
 */

/** `{SITE_URL}/bookings/open?lang=ja#g=<grant>`：grant は fragment だけ。`lang=ja` は、リンクが使えなかったときの案内を日本語にするため。 */
const bookingPageLink = (siteUrl: string, grant: string) => `${absolute(siteUrl, "/bookings/open")}?lang=ja#g=${encodeURIComponent(grant)}`;
const NEW_LINK_PAGE = (siteUrl: string) => `${absolute(siteUrl, "/bookings")}?lang=ja`;

const SUPPORT_REPLY = "ご不明な点や変更・取消のご希望は、このメールに返信してください。NIHO事務局が日本語でご案内します。";

const greeting = (name: string): MailBlock => ({ kind: "p", text: `${oneLine(name)} 様` });
const japanMail = (subject: string, blocks: readonly MailBlock[]): RenderedMail => mail(subject, blocks, "ja");
const when = (localDate: string, localStartTime: string) => `${calendarDateJa(localDate)} ${localStartTime}`;

export function bookingConfirmationEmailJa(
  email: BookingConfirmationEmail,
  options: { readonly siteUrl: string; readonly now: Date; readonly bookingPageGrant?: string | null },
): RenderedMail {
  const experience = oneLine(email.experienceTitle);
  const host = oneLine(email.hostDisplayName);
  const managed = email.managedSeller;
  const provider = managed?.providerDisplayName ? oneLine(managed.providerDisplayName) : null;
  const free = email.totalAmount === 0;
  const policy = free ? "無料のご予約は、体験が終わるまでいつでもキャンセルできます。" : cancellationTermsWordsJa(email, options.now);
  const grant = options.bookingPageGrant;
  return japanMail(`ご予約が確定しました：${experience}（${when(email.localDate, email.localStartTime)}）`, [
    greeting(email.guestName),
    { kind: "p", text: free ? "無料のご予約が確定しました。お支払いは不要です。" : "ご予約が確定し、お支払いが完了しました。内容をご確認ください。" },
    {
      kind: "facts",
      rows: [
        ["体験", experience],
        ["日付", calendarDateJa(email.localDate)],
        ["時間", `${email.localStartTime}（${zoneNameJa(email.timeZone)}）`],
        ["人数", partyJa(email.adultCount, email.childCount)],
        [free ? "合計" : "お支払い額", free ? "無料" : moneyJa(email.totalAmount, email.currency)],
        ...(managed ? [["販売者", oneLine(managed.displayName)] as const, ...(provider ? [["ホスト", provider] as const] : [])] : [["ホスト", host] as const]),
        ["予約番号", email.publicBookingId],
      ],
    },
    ...(policy ? [{ kind: "p", text: policy } as const] : []),
    ...(grant
      ? [
          {
            kind: "link",
            lead: `サイトでご予約を確認できます。リンクは1回だけ使え、1つの端末でご予約を開きます。転送しないでください。新しいリンクは ${NEW_LINK_PAGE(options.siteUrl)} からいつでも請求できます。`,
            label: "ご予約を確認する",
            href: bookingPageLink(options.siteUrl, grant),
          } as const,
        ]
      : []),
    { kind: "p", text: `${managed ? "NIHO事務局" : host}から、開催前に集合場所などのご案内をお送りします。` },
    { kind: "link", lead: "体験のページ：", label: experience, href: absolute(options.siteUrl, `/ja/experiences/${encodeURIComponent(email.experienceSlug)}`) },
    { kind: "p", text: SUPPORT_REPLY },
  ]);
}

export function bookingLinkEmailJa(email: BookingLinkEmail, options: { readonly siteUrl: string; readonly bookingPageGrant: string }): RenderedMail {
  const experience = oneLine(email.experienceTitle);
  return japanMail(`ご予約の確認リンク：${experience}（${when(email.localDate, email.localStartTime)}）`, [
    greeting(email.guestName),
    { kind: "p", text: "NIHO Experience でご依頼いただいた、ご予約の確認リンクをお送りします。" },
    {
      kind: "facts",
      rows: [
        ["体験", experience],
        ["日付", calendarDateJa(email.localDate)],
        ["時間", `${email.localStartTime}（${zoneNameJa(email.timeZone)}）`],
        ["予約番号", email.publicBookingId],
      ],
    },
    {
      kind: "link",
      lead: `リンクは30日まで、1回だけ使え、1つの端末でご予約を開きます。転送しないでください。新しいリンクは ${NEW_LINK_PAGE(options.siteUrl)} からいつでも請求できます。`,
      label: "ご予約を確認する",
      href: bookingPageLink(options.siteUrl, options.bookingPageGrant),
    },
    { kind: "p", text: "お心当たりがない場合は、このメールを破棄してください。" },
    { kind: "p", text: "ご不明な点は、このメールに返信してください。NIHO事務局が日本語でご案内します。" },
  ]);
}

export function bookingNoticeEmailJa(email: BookingNoticeEmail, options: { readonly siteUrl: string; readonly bookingPageGrant?: string | null }): RenderedMail {
  const experience = oneLine(email.experienceTitle);
  const day = when(email.localDate, email.localStartTime);
  const facts: MailBlock = {
    kind: "facts",
    rows: [
      ["体験", experience],
      ["日付", calendarDateJa(email.localDate)],
      ["時間", `${email.localStartTime}（${zoneNameJa(email.timeZone)}）`],
      ["予約番号", email.publicBookingId],
    ],
  };
  const grant = options.bookingPageGrant;
  const page: MailBlock[] = grant
    ? [
        { kind: "link", lead: "サイトでご予約を確認できます。リンクは1回だけ使えます。転送しないでください。", label: "ご予約を確認する", href: bookingPageLink(options.siteUrl, grant) },
      ]
    : [];
  const support: MailBlock = { kind: "p", text: "ご不明な点は、このメールに返信してください。NIHO事務局が日本語でご案内します。" };
  if (email.kind === "CANCELLED") {
    const refund = email.refundAmount > 0
      ? `お支払いのカードへ ${moneyJa(email.refundAmount, email.currency)} の返金を手続きしました。完了したら、あらためてメールでお知らせします。`
      : email.totalAmount === 0 ? "お支払いはありませんでしたので、返金はありません。" : "このご予約は返金の対象ではありません。";
    return japanMail(`ご予約がキャンセルされました：${experience}（${day}）`, [
      greeting(email.guestName),
      { kind: "p", text: cancelledByJa({ cancelledBy: email.cancelledBy, cancellationReason: email.reason, hostDisplayName: oneLine(email.hostDisplayName) }) },
      facts,
      { kind: "p", text: refund },
      ...page,
      support,
    ]);
  }
  if (email.kind === "REFUNDED") {
    return japanMail(`返金が完了しました：${experience}（${day}）`, [
      greeting(email.guestName),
      { kind: "p", text: `お支払いのカードへ ${moneyJa(email.amount, email.currency)} を返金しました。${REFUND_TIMING_JA}` },
      facts,
      ...page,
      support,
    ]);
  }
  return japanMail(`キャンセルのご依頼について：${experience}（${day}）`, [
    greeting(email.guestName),
    { kind: "p", text: "キャンセルのご依頼を NIHO事務局が確認しました。ご予約は引き続き有効です。" },
    { kind: "quote", text: body(email.message) },
    facts,
    ...page,
    { kind: "p", text: "ご返信は、このメールへの返信でお願いします。NIHO事務局が日本語でご案内します。" },
  ]);
}

export function reviewInvitationEmailJa(email: ReviewInvitationEmail, options: { readonly siteUrl: string; readonly token: string }): RenderedMail {
  const experience = oneLine(email.experienceTitle);
  const link = `${absolute(options.siteUrl, "/reviews/write")}#t=${encodeURIComponent(options.token)}`;
  return japanMail(`ご参加ありがとうございました：${experience}`, [
    greeting(email.guestName),
    { kind: "p", text: `${experience}にご参加いただき、ありがとうございました。楽しんでいただけていれば幸いです。` },
    { kind: "p", text: "よろしければ、公開のレビューを1件お書きください。ホストへの非公開のメモは公開されません。" },
    { kind: "link", lead: "レビューを書く：", label: "レビューを書く", href: link },
    { kind: "p", text: "レビューの投稿ページは現在、英語の表示のみです。日本語でのお問い合わせは、このメールへの返信で受け付けます。" },
  ]);
}

export function bookingMeetingGuideEmailJa(
  email: BookingMeetingGuideEmail,
  options: { readonly siteUrl: string; readonly bookingPageGrant: string; readonly photo: Uint8Array },
): RenderedMail {
  const experience = oneLine(email.experienceTitle);
  const cid = "niho-meeting-place-photo";
  const blocks: MailBlock[] = [
    greeting(email.guestName),
    { kind: "p", text: `${experience}の集合場所をご案内します。` },
    { kind: "facts", rows: [["日付", calendarDateJa(email.localDate)], ["時間", `${email.localStartTime}（${zoneNameJa(email.timeZone)}）`], ["集合場所", oneLine(email.collectionOverview)]] },
    { kind: "image", cid, alt: "集合場所の外観" },
    { kind: "p", text: oneLine(email.address) },
    ...(email.accessInstructions ? [{ kind: "p", text: body(email.accessInstructions) } as const] : []),
    ...(email.entranceInstructions ? [{ kind: "p", text: body(email.entranceInstructions) } as const] : []),
    ...(email.mapUrl ? [{ kind: "link", lead: "集合場所の地図：", label: "地図を開く", href: email.mapUrl } as const] : []),
    ...(email.itemsToBring.length ? [{ kind: "facts", rows: [["持ち物", email.itemsToBring.map(oneLine).join("、")]] } as const] : []),
    ...(email.weatherPlan ? [{ kind: "p", text: `雨天時の対応：${body(email.weatherPlan)}` } as const] : []),
    { kind: "link", lead: "遅れる場合や集合場所が分からない場合は、ご予約のページからホストへ連絡できます：", label: "ご予約を開く", href: bookingPageLink(options.siteUrl, options.bookingPageGrant) },
    { kind: "p", text: "お急ぎの場合や日本語でのお問い合わせは、このメールに返信してください。NIHO事務局が日本語でご案内します。" },
  ];
  return {
    ...japanMail(`集合場所のご案内：${experience}（${when(email.localDate, email.localStartTime)}）`, blocks),
    attachments: [{ filename: "meeting-place.jpg", content: options.photo, contentType: "image/jpeg", cid }],
  };
}

const messageFacts = (message: { publicBookingId: string; localDate: string; localStartTime: string; timeZone: string }, experience: string): MailBlock => ({
  kind: "facts",
  rows: [["体験", experience], ["日付", calendarDateJa(message.localDate)], ["時間", `${message.localStartTime}（${zoneNameJa(message.timeZone)}）`], ["予約番号", message.publicBookingId]],
});

/** ホストが書いた日本語（無ければ英語）を、書いたままの本文として使う。枠の文言だけが日本語。 */
const hostWords = (message: { japanese: string | null; english: string }) => body(message.japanese ?? message.english);

export function bookingMessageEmailJa(
  message: Pick<ClaimedBookingMessage, "guestName" | "hostDisplayName" | "experienceTitle" | "english" | "japanese" | "publicBookingId" | "localDate" | "localStartTime" | "timeZone">,
  options: { readonly siteUrl: string; readonly bookingPageGrant: string | null },
): RenderedMail {
  const host = oneLine(message.hostDisplayName);
  const experience = oneLine(message.experienceTitle);
  const grant = options.bookingPageGrant;
  return japanMail(`${host}からご予約についてメッセージが届いています：${experience}（${when(message.localDate, message.localStartTime)}）`, [
    greeting(message.guestName),
    { kind: "p", text: `${host}から、ご予約についてメッセージが届いています。` },
    { kind: "quote", text: hostWords(message) },
    messageFacts(message, experience),
    ...(grant
      ? [{
          kind: "link",
          lead: `${host}への返信は、ご予約のページで書けます。リンクは1回だけ使え、1つの端末でご予約を開きます。転送しないでください。新しいリンクは ${NEW_LINK_PAGE(options.siteUrl)} からいつでも請求できます。`,
          label: "ご予約を確認する",
          href: bookingPageLink(options.siteUrl, grant),
        } as const]
      : []),
    { kind: "p", text: `このメールへの返信は、${host}ではなく NIHO事務局に届きます。NIHO事務局が日本語でご案内します。` },
  ]);
}

export function supportBookingMessageEmailJa(
  message: Pick<ClaimedSupportBookingMessage, "guestName" | "experienceTitle" | "english" | "japanese" | "publicBookingId" | "localDate" | "localStartTime" | "timeZone">,
  options: { readonly siteUrl: string; readonly bookingPageGrant: string | null },
): RenderedMail {
  const experience = oneLine(message.experienceTitle);
  const grant = options.bookingPageGrant;
  return japanMail(`NIHO事務局からご予約についてメッセージが届いています：${experience}（${when(message.localDate, message.localStartTime)}）`, [
    greeting(message.guestName),
    { kind: "p", text: "NIHO事務局から、ご予約についてメッセージが届いています。" },
    { kind: "quote", text: hostWords(message) },
    messageFacts(message, experience),
    ...(grant ? [{ kind: "link", lead: "ご予約のページで、NIHO事務局とのやりとりを続けられます。リンクは1回だけ使え、1つの端末でご予約を開きます。転送しないでください。", label: "ご予約を確認する", href: bookingPageLink(options.siteUrl, grant) } as const] : []),
    { kind: "p", text: "このメールへの返信は、提供者ではなく NIHO事務局に届きます。" },
  ]);
}

export function questionReplyEmailJa(input: QuestionReplyMailInput & { readonly japanese?: string | null }): RenderedMail {
  const host = oneLine(input.hostName);
  const experience = input.experienceTitle === null ? null : oneLine(input.experienceTitle);
  const link = `${absolute(input.siteUrl, "/questions/reply")}#t=${encodeURIComponent(input.replyToken)}`;
  return japanMail(experience === null ? `${host}さんからメッセージの返信が届きました` : `${host}からご質問への返信が届きました：${experience}`, [
    greeting(input.guestName),
    { kind: "p", text: experience === null ? `あなたのメッセージに、${host}さんが返信しました。` : `${experience}についてのご質問に、${host}が返信しました。` },
    { kind: "quote", text: body(input.japanese ?? input.reply) },
    { kind: "link", lead: `${host}へ返信するには、このリンクを開いてください。このリンクで返信できるのは1回で、期限は${input.linkTtlDays}日です。`, label: `${host}に返信する`, href: link },
    { kind: "p", text: "このメールへの返信は、" + host + "ではなく NIHO事務局に届き、NIHO事務局が日本語でご案内します。" },
  ]);
}
