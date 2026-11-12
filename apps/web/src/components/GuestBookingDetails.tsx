import type { GuestBookingConversation, GuestBookingView, GuestRefundView } from "@niho-experience/experience-store";
import Image from "next/image";
import type { ReactNode } from "react";
import { DATE_LONG, REFUND_TIMING, calendarDate, cancellationWords, cancelledBy, money, party, zoneName, zonedMoment } from "@/lib/booking-words";
import { REFUND_TIMING_JA, calendarDateJa, cancellationWordsJa, cancelledByJa, moneyJa, partyJa, zoneNameJa, zonedMomentJa } from "@/lib/booking-words-ja";
import { BookingCancel } from "./BookingCancel";
import { BookingMessages } from "./BookingMessages";
import { BookingSignOut } from "./BookingSignOut";
import { FindBookingForm } from "./FindBookingForm";
import { ButtonLink, Notice, Pill } from "./ui";

type Locale = "en" | "ja";

const STATUS = {
  CONFIRMED: { label: "Confirmed", ja: "予約確定", tone: "neutral" },
  PAYMENT_REVIEW: { label: "Payment under review", ja: "お支払いを確認中", tone: "warn" },
  CANCELLED: { label: "Cancelled", ja: "キャンセル済み", tone: "muted" },
} as const;

const moment = (instant: string, timeZone: string, locale: Locale = "en") => locale === "ja"
  ? `${zonedMomentJa(Date.parse(instant), timeZone)}（${zoneNameJa(timeZone)}）`
  : `${zonedMoment(Date.parse(instant), timeZone)} ${zoneName(timeZone)}`;

/** One refund in words: on its way, done (with when), or failed (support will write). */
function refundLine(refund: GuestRefundView, timeZone: string, locale: Locale = "en"): string {
  if (locale === "ja") {
    const amount = moneyJa(refund.amount, refund.currency);
    if (refund.status === "REFUNDED") return `${refund.refundedAtUtc ? `${moment(refund.refundedAtUtc, timeZone, "ja")}に` : ""}お支払いのカードへ${amount}を返金しました。${REFUND_TIMING_JA}`;
    if (refund.status === "FAILED") return `カードへの${amount}の返金ができませんでした。NIHO事務局からメールでご連絡します。`;
    return `お支払いのカードへ${amount}の返金を手続き中です。完了したらメールでお知らせします。`;
  }
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
function CancelSection({ booking, locale }: { booking: GuestBookingView; locale: Locale }) {
  const ja = locale === "ja";
  const p = "mt-3 text-[0.9375rem] text-ink-soft";
  let body: ReactNode;
  if (booking.status === "CANCELLED") {
    body = booking.refunds.length
      ? booking.refunds.map((refund, index) => <p key={index} className={p}>{refundLine(refund, booking.timeZone, locale)}</p>)
      : <p className={p}>{booking.totalAmount === 0 ? (ja ? "お支払いはありませんでしたので、返金はありません。" : "No payment was required, so no refund was needed.") : (ja ? "このご予約の返金はありません。" : "No refund was made for this booking.")}</p>;
  } else if (booking.status === "PAYMENT_REVIEW") {
    body = <p className={p}>{ja ? "お支払いについて、NIHO事務局からメールでご連絡します。ご不明な点は、確認メールに返信してください。" : "NIHO support will email you about your payment. For questions, reply to your confirmation email."}</p>;
  } else if (booking.experienceEnded) {
    body = <p className={p}>{ja ? "この体験は終了しました。ご不明な点は、確認メールに返信してください。NIHO事務局が日本語でご案内します。" : "This experience has ended. For questions about it, reply to your confirmation email and NIHO support will help."}</p>;
  } else if (booking.totalAmount === 0) {
    body = <>
      <p className={p}>{ja ? "お支払いは不要です。無料のご予約は、体験が終わるまでいつでもキャンセルできます。" : "No payment was required. You can cancel this free booking any time before the experience ends."}</p>
      <BookingCancel publicBookingId={booking.publicBookingId} choice="REQUEST" shownDeadlineUtc={booking.freeCancellationUntilUtc} refundWords={null} freeBooking locale={locale} />
    </>;
  } else if (booking.freeCancellationOpen && booking.freeCancellationUntilUtc) {
    const total = ja ? moneyJa(booking.totalAmount, booking.currency) : money(booking.totalAmount, booking.currency);
    body = (
      <>
        <p className={p}>{ja ? `${moment(booking.freeCancellationUntilUtc, booking.timeZone, "ja")}まで無料でキャンセルできます。お支払いのカードへ${total}を全額返金します。` : <>You can cancel for free until {moment(booking.freeCancellationUntilUtc, booking.timeZone)}. We&apos;ll refund {total} in full to the card you paid with.</>}</p>
        <BookingCancel
          publicBookingId={booking.publicBookingId}
          choice="FULL_REFUND"
          shownDeadlineUtc={booking.freeCancellationUntilUtc}
          refundWords={ja ? `お支払いのカードへ${total}を全額返金します。${REFUND_TIMING_JA}` : `We'll refund ${total} in full to the card you paid with. ${REFUND_TIMING}`}
          locale={locale}
        />
      </>
    );
  } else if (booking.cancellationRequest?.status === "OPEN") {
    body = <p className={p}>{ja ? `${moment(booking.cancellationRequest.requestedAtUtc, booking.timeZone, "ja")}にキャンセルをご依頼いただきました。NIHO事務局がメールでご返信します。それまでご予約は有効です。` : `You asked to cancel on ${moment(booking.cancellationRequest.requestedAtUtc, booking.timeZone)}. NIHO support will reply by email. Your booking stays confirmed until then.`}</p>;
  } else if (booking.cancellationRequest?.status === "DECLINED") {
    body = (
      <>
        <p className={p}>{ja ? "キャンセルのご依頼に、NIHO事務局が返信しました。ご予約は引き続き有効です。" : "NIHO support replied to your request to cancel. Your booking stays confirmed."}</p>
        {booking.cancellationRequest.declineMessage ? (
          <blockquote className="mt-3 border-l-4 border-line pl-4 text-[0.9375rem] whitespace-pre-line [overflow-wrap:anywhere]">{booking.cancellationRequest.declineMessage}</blockquote>
        ) : null}
        <p className={p}>{ja ? "ご返信は、NIHO事務局からのメールへの返信でお願いします。" : "To reply, answer the email from NIHO support."}</p>
      </>
    );
  } else {
    body = (
      <>
        <p className={p}>
          {ja
            ? `${booking.cancellationPolicy === "NONE" ? "このご予約は返金できません。" : "無料キャンセルの受付は終了しました。"}それでも、キャンセルを依頼できます。NIHO事務局が内容を確認し、メールでご返信します。それまでご予約は有効です。`
            : `${booking.cancellationPolicy === "NONE" ? "This booking is non-refundable." : "Free cancellation has ended."} You can still ask to cancel: NIHO support will look at your request and reply by email. Your booking stays confirmed until then.`}
        </p>
        <BookingCancel publicBookingId={booking.publicBookingId} choice="REQUEST" shownDeadlineUtc={booking.freeCancellationUntilUtc} refundWords={null} locale={locale} />
      </>
    );
  }
  return (
    <section aria-labelledby="booking-changes" className="mt-8">
      <h2 id="booking-changes" className="font-sans text-sm font-extrabold tracking-[0.04em] text-muted uppercase">
        {booking.status === "CANCELLED" ? (ja ? "返金" : "Refund") : (ja ? "キャンセル" : "Cancel")}
      </h2>
      {body}
    </section>
  );
}

/**
 * The guest's booking (#285 slice 6, docs/guest-booking.md): what was booked, for when and whom, what was paid and the
 * cancellation policy fixed at booking, cancelling it (slice 7), and the messages with the host (slice 6b): the guest's
 * words and the host's English, and a box to write while the booking takes messages. `conversation` is null when the
 * messages could not be read (the rest of the page still shows).
 */
export function GuestBookingDetails({ booking, now, conversation = null, translationNotice = false }: { booking: GuestBookingView; now: Date; conversation?: GuestBookingConversation | null; translationNotice?: boolean }) {
  // The page speaks the language the booking was made in (#59); nothing else changes between the two.
  const locale: Locale = booking.guestLanguage === "JA" ? "ja" : "en";
  const ja = locale === "ja";
  const status = STATUS[booking.status];
  const policy = booking.status === "CANCELLED" ? null : booking.totalAmount === 0
    ? (ja ? "無料のご予約は、体験が終わるまでいつでもキャンセルできます。" : "This free booking can be cancelled any time before the experience ends.")
    : ja ? cancellationWordsJa(booking, now) : cancellationWords(booking, now);
  const rows: [string, string][] = ja ? [
    ["日付", calendarDateJa(booking.localDate)],
    ["時間", `${booking.localStartTime}（${zoneNameJa(booking.timeZone)}）`],
    ["人数", partyJa(booking.adultCount, booking.childCount)],
    [booking.totalAmount === 0 ? "合計" : "お支払い額", booking.totalAmount === 0 ? "無料" : moneyJa(booking.totalAmount, booking.currency)],
    ["ホスト", booking.hostDisplayName],
    ["お申込み者", booking.guestName],
    ["お申込み日時", moment(booking.bookedAtUtc, booking.timeZone, "ja")],
    ["予約番号", booking.publicBookingId],
  ] : [
    ["Date", calendarDate(booking.localDate, DATE_LONG)],
    ["Time", `${booking.localStartTime} ${zoneName(booking.timeZone)}`],
    ["Guests", party(booking.adultCount, booking.childCount)],
    [booking.totalAmount === 0 ? "Total" : "Total paid", booking.totalAmount === 0 ? "Free" : money(booking.totalAmount, booking.currency)],
    ["Host", booking.hostDisplayName],
    ["Booked by", booking.guestName],
    ["Booked on", `${zonedMoment(Date.parse(booking.bookedAtUtc), booking.timeZone)} ${zoneName(booking.timeZone)}`],
    ["Booking reference", booking.publicBookingId],
  ];
  return (
    <div className="container-page max-w-2xl py-12" lang={ja ? "ja" : undefined}>
      <p className="hand text-[1.75rem]">{ja ? "ご予約" : "your booking"}</p>
      <h1 className="mt-1 text-3xl [overflow-wrap:anywhere]">{booking.experienceTitle}</h1>
      <p className="mt-3 flex flex-wrap items-center gap-2">
        <Pill tone={status.tone}>{ja ? status.ja : status.label}</Pill>
      </p>
      {booking.status === "PAYMENT_REVIEW" ? (
        <div className="mt-5">
          <Notice tone="warn" title={ja ? "ご予約はまだ確定していません" : "Your place isn't confirmed yet"}>
            {ja ? "席の確保期限が過ぎた後にお支払いを確認しました。NIHO事務局からメールでご連絡します。" : "Your payment reached us after your hold on the place ended. NIHO support will email you about it."}
          </Notice>
        </div>
      ) : null}
      {booking.status === "CANCELLED" ? (
        <div className="mt-5">
          <Notice tone="neutral" title={ja ? "このご予約はキャンセルされました" : "This booking was cancelled"}>
            {ja ? cancelledByJa(booking) : cancelledBy(booking)}
            {booking.cancelledAtUtc ? (ja ? `${moment(booking.cancelledAtUtc, booking.timeZone, "ja")}にキャンセルされました。` : ` Cancelled on ${moment(booking.cancelledAtUtc, booking.timeZone)}.`) : null}
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
        <ButtonLink href={`${ja ? "/ja" : ""}/experiences/${encodeURIComponent(booking.experienceSlug)}`} variant="secondary">{ja ? "体験のページを見る" : "See the experience"}</ButtonLink>
      </div>

      {booking.status === "CONFIRMED" && booking.meetingGuide ? (
        <section aria-labelledby="booking-meeting-guide" className="mt-10 border-t border-line pt-6">
          <h2 id="booking-meeting-guide" className="font-sans text-sm font-extrabold tracking-[0.04em] text-muted uppercase">{ja ? "集合場所のご案内" : "Meeting details"}</h2>
          <h3 className="mt-3 text-xl font-bold">{booking.meetingGuide.collectionOverview}</h3>
          {booking.meetingGuide.photoUrl ? <Image src={booking.meetingGuide.photoUrl} width={1200} height={800} unoptimized alt={ja ? "集合場所の外観" : "The outside of the meeting place"} className="mt-4 max-h-80 w-full rounded-xl object-cover" referrerPolicy="no-referrer" /> : null}
          <p className="mt-4 whitespace-pre-line text-[0.9375rem] font-bold [overflow-wrap:anywhere]">{booking.meetingGuide.address}</p>
          {booking.meetingGuide.mapUrl ? <p className="mt-3"><a href={booking.meetingGuide.mapUrl} target="_blank" rel="noreferrer" className="font-bold text-moss underline">{ja ? "地図を開く" : "Open map"}</a></p> : null}
          {booking.meetingGuide.accessInstructions ? <p className="mt-4 whitespace-pre-line text-[0.9375rem] [overflow-wrap:anywhere]">{booking.meetingGuide.accessInstructions}</p> : null}
          {booking.meetingGuide.entranceInstructions ? <p className="mt-3 whitespace-pre-line text-[0.9375rem] [overflow-wrap:anywhere]">{booking.meetingGuide.entranceInstructions}</p> : null}
          {booking.meetingGuide.itemsToBring.length ? (
            <div className="mt-5">
              <h3 className="font-bold">{ja ? "持ち物" : "What to bring"}</h3>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-[0.9375rem]">{booking.meetingGuide.itemsToBring.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul>
            </div>
          ) : null}
          {booking.meetingGuide.weatherPlan ? <p className="mt-5 whitespace-pre-line text-[0.9375rem] [overflow-wrap:anywhere]"><span className="font-bold">{ja ? "雨天時の対応：" : "Weather plan: "}</span>{booking.meetingGuide.weatherPlan}</p> : null}
        </section>
      ) : null}

      <section aria-labelledby="booking-messages" className="mt-10 border-t border-line pt-6">
        <h2 id="booking-messages" className="font-sans text-sm font-extrabold tracking-[0.04em] text-muted uppercase">{ja ? "ホストとのメッセージ" : "Messages with your host"}</h2>
        <BookingMessages
          publicBookingId={booking.publicBookingId}
          hostDisplayName={booking.hostDisplayName}
          timeZone={booking.timeZone}
          conversation={conversation}
          translationNotice={translationNotice && !ja}
          locale={locale}
          quickReplies={booking.status === "CONFIRMED" && booking.meetingGuide?.isDayOf ? (ja ? [
            { label: "遅れそうです", message: "遅れそうです。到着予定時刻は次のとおりです：" },
            { label: "集合場所が分かりません", message: "集合場所が分かりません。教えていただけますか？" },
            { label: "その他", message: "こんにちは。本日の集合について質問があります。" },
          ] : [
            { label: "I'm running late", message: "I'm running late. My estimated arrival time is: " },
            { label: "I can't find the meeting point", message: "I can't find the meeting point. Could you help me?" },
            { label: "Something else", message: "Hi, I have a question about today's meeting." },
          ]) : []}
        />
      </section>
      <CancelSection booking={booking} locale={locale} />

      <section aria-labelledby="booking-device" className="mt-10 border-t border-line pt-6">
        <h2 id="booking-device" className="font-sans text-sm font-extrabold tracking-[0.04em] text-muted uppercase">{ja ? "この端末について" : "This device"}</h2>
        <p className="mt-3 mb-4 text-[0.9375rem] text-ink-soft">
          {ja
            ? "このご予約は、体験の30日後まで、または30日間アクセスがないまで、このブラウザーで開いたままになります。共有の端末では、使い終わったらログアウトしてください。新しいリンクはいつでも請求できます。"
            : <>This booking stays open in this browser until 30 days after the experience, or until 30 days pass without a visit. On a shared device, sign out when you&apos;re done; you can ask for a new link any time.</>}
        </p>
        <BookingSignOut publicBookingId={booking.publicBookingId} locale={locale} />
      </section>
    </div>
  );
}

/**
 * What `/bookings/{id}` shows without a session for that booking, and for an ID that is not one: the same page, so it
 * says nothing about whether the booking exists.
 */
export function BookingNotOpen({ locale = "en" }: { locale?: Locale }) {
  const ja = locale === "ja";
  return (
    <div className="container-page max-w-2xl py-12" lang={ja ? "ja" : undefined}>
      <p className="hand text-[1.75rem]">{ja ? "ご予約" : "your booking"}</p>
      <h1 className="mt-1 text-3xl">{ja ? "ご予約は、メールのリンクから開いてください" : "Open this booking from your email"}</h1>
      <p className="mt-3 text-ink-soft">
        {ja
          ? "確認メールの「ご予約を確認する」のリンクをお使いください。リンクは1回だけ使えます。使用済みや期限切れの場合は、新しいリンクをメールでお送りします。"
          : <>Use the &ldquo;View your booking&rdquo; link in your confirmation email. Each link works once; if yours has been used or is too old, we can email you a new one.</>}
      </p>
      <h2 className="mt-8 font-sans text-sm font-extrabold tracking-[0.04em] text-muted uppercase">{ja ? "新しいリンクを送る" : "Send me a new link"}</h2>
      <FindBookingForm submitLabel={ja ? "新しいリンクを送る" : "Send me a new link"} locale={locale} />
    </div>
  );
}

/** The booking could not be read (the database did not answer): says nothing about the booking either. */
export function BookingUnavailable({ locale = "en" }: { locale?: Locale }) {
  const ja = locale === "ja";
  return (
    <div className="container-page max-w-2xl py-12" lang={ja ? "ja" : undefined}>
      <p className="hand text-[1.75rem]">{ja ? "うまくいきませんでした" : "something went wrong"}</p>
      <h1 className="mt-1 text-3xl">{ja ? "ご予約を開けませんでした" : <>We couldn&apos;t open your booking</>}</h1>
      <p className="mt-3 text-ink-soft">{ja ? "しばらくしてから、もう一度お試しください。このページを再読み込みするだけで構いません。" : "Please try again in a moment. Reloading this page is enough."}</p>
    </div>
  );
}
