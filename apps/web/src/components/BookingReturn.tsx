import { HandIcon, type HandIconName } from "./HandIcon";
import { ButtonLink } from "./ui";

/** An allowlisted return-page variant. Other values show the neutral page. */
export type BookingReturnType = "instant" | "approval" | "managed-request";

export function readReturnType(value: string | string[] | undefined): BookingReturnType | null {
  return value === "instant" || value === "approval" || value === "managed-request" ? value : null;
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
export function BookingReturn({ type, showReview, freeBooking = false, locale = "en" }: { type: BookingReturnType | null; showReview: boolean; freeBooking?: boolean; locale?: "en" | "ja" }) {
  if (locale === "ja") return <BookingReturnJa type={type} showReview={showReview} freeBooking={freeBooking} />;
  const approval = type === "approval";
  const managedRequest = type === "managed-request";
  const eyebrow = type ? "thank you" : "almost there";
  const heading = managedRequest ? "NIHO will review your request" : approval ? "The host will review your request" : freeBooking ? "Check your email for your free booking" : type ? "Check your email for your booking" : "Check your email";
  const lead = managedRequest
    ? "We’ll email you a receipt for your request. Submitting a request does not require a card or take payment. If NIHO approves it, we’ll email you a Stripe payment link."
    : approval
    ? "You are charged only if they accept. We email you either way."
    : freeBooking
      ? "No payment is due. Your booking confirmation will arrive by email."
      : type
      ? "Your confirmation comes by email once your payment goes through."
      : "We email you about your booking. If the host needs to approve your request, the email says so.";
  const steps: Step[] = [
    { icon: "mail", title: managedRequest ? "Wait for NIHO to reply" : approval ? "An email about your request" : "Your confirmation email", text: managedRequest ? "If approved, use the payment link before it expires. Your booking is confirmed after payment." : approval ? "It tells you the request is with the host. Another follows when they answer." : freeBooking ? "The experience, date and time, your group and a link to your booking. No payment is due." : "The experience, the date and time, your group, what you paid and a link to your booking." },
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

/**
 * 日本語の戻りページ（#59）。英語版と同じ事実だけを言う：このページは予約の状況を示さず、次に何が起きるかだけを言う。
 * 種別は URL の固定語（自由記入ではない）で決まり、誰も自分の文言を差し込めない。
 */
function BookingReturnJa({ type, showReview, freeBooking }: { type: BookingReturnType | null; showReview: boolean; freeBooking: boolean }) {
  const approval = type === "approval";
  const managedRequest = type === "managed-request";
  const eyebrow = type ? "ありがとうございます" : "もうすぐです";
  const heading = managedRequest ? "お申込みを受け付けました" : approval ? "ホストが内容を確認します" : freeBooking ? "無料のご予約の確認メールをご確認ください" : type ? "ご予約の確認メールをご確認ください" : "メールをご確認ください";
  const lead = managedRequest
    ? "まだ予約は確定していません。お申込みの受付メールをお送りします。事務局が内容を確認し、24時間以内にメールでお返事します。ここまでカードの入力やお支払いは要りません。日程が決まったら、お支払いのリンクをお送りします。"
    : approval
      ? "ホストが承認した場合にだけ、お支払いが発生します。結果はどちらの場合もメールでお知らせします。"
      : freeBooking
        ? "お支払いは不要です。ご予約の確認は、メールでお送りします。"
        : type
          ? "お支払いが完了すると、ご予約の確認をメールでお送りします。"
          : "ご予約についてメールでお知らせします。ホストの承認が必要な場合は、メールにそのことを書きます。";
  const steps: Step[] = [
    { icon: "mail", title: managedRequest ? "事務局からのお返事をお待ちください" : approval ? "お申込みについてのメール" : "確認メール", text: managedRequest ? "承認された場合は、期限内にお支払いリンクからお支払いください。お支払い後にご予約が確定します。" : approval ? "お申込みがホストに届いたことをお知らせします。ホストが答えたら、あらためてお送りします。" : freeBooking ? "体験、日時、人数と、ご予約のページへのリンクをお知らせします。お支払いは不要です。" : "体験、日時、人数、お支払い額と、ご予約のページへのリンクをお知らせします。" },
    { icon: "pin", title: "集合場所のご案内", text: "集合場所は、当日より前にお届けします。" },
    { icon: "cal", title: "ホストに会う", text: "当日は、ご案内した集合場所でホストにお会いください。" },
    ...(showReview ? [{ icon: "chat" as const, title: "感想を聞かせてください", text: "体験のあとで、いかがでしたかとおたずねします。" }] : []),
  ];
  return (
    <div className="container-page max-w-2xl py-12" lang="ja">
      <p className="hand text-[1.75rem]">{eyebrow}</p>
      <h1 className="mt-1 text-3xl">{heading}</h1>
      <p className="mt-3 text-ink-soft">{lead}</p>
      <h2 className="mt-9 font-sans text-sm font-extrabold tracking-[0.04em] text-muted">このあとの流れ</h2>
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
      <p className="mt-8 text-sm text-muted">このページには、ご予約の状況は表示されません。状況は、お送りするメールでご確認ください。</p>
      <div className="mt-6 flex flex-wrap gap-3">
        <ButtonLink href="/ja/help">メールが届かないとき</ButtonLink>
        <ButtonLink href="/ja/experiences" variant="secondary">体験を探す</ButtonLink>
      </div>
    </div>
  );
}
