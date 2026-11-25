/*
 * The words at the top of the booking return page (src/components/BookingReturn.tsx). The booking widget (#638) shows the
 * same heading and lead in its frame when checkout answers with this site's own return page, so both read them from here.
 */

/** An allowlisted return-page variant. Other values show the neutral page. */
export type BookingReturnType = "instant" | "approval" | "managed-request";

export function readReturnType(value: string | string[] | undefined | null): BookingReturnType | null {
  return value === "instant" || value === "approval" || value === "managed-request" ? value : null;
}

export type BookingReturnCopy = { readonly eyebrow: string; readonly heading: string; readonly lead: string };

export function bookingReturnCopy(type: BookingReturnType | null, freeBooking: boolean, locale: "en" | "ja" = "en"): BookingReturnCopy {
  const approval = type === "approval";
  const managedRequest = type === "managed-request";
  if (locale === "ja") {
    return {
      eyebrow: type ? "ありがとうございます" : "もうすぐです",
      heading: managedRequest ? "お申込みを受け付けました" : approval ? "ホストが内容を確認します" : freeBooking ? "無料のご予約の確認メールをご確認ください" : type ? "ご予約の確認メールをご確認ください" : "メールをご確認ください",
      lead: managedRequest
        ? "まだ予約は確定していません。お申込みの受付メールをお送りします。事務局が内容を確認し、24時間以内にメールでお返事します。ここまでカードの入力やお支払いは要りません。日程が決まったら、お支払いのリンクをお送りします。"
        : approval
          ? "ホストが承認した場合にだけ、お支払いが発生します。結果はどちらの場合もメールでお知らせします。"
          : freeBooking
            ? "お支払いは不要です。ご予約の確認は、メールでお送りします。"
            : type
              ? "お支払いが完了すると、ご予約の確認をメールでお送りします。"
              : "ご予約についてメールでお知らせします。ホストの承認が必要な場合は、メールにそのことを書きます。",
    };
  }
  return {
    eyebrow: type ? "thank you" : "almost there",
    heading: managedRequest ? "NIHO will review your request" : approval ? "The host will review your request" : freeBooking ? "Check your email for your free booking" : type ? "Check your email for your booking" : "Check your email",
    lead: managedRequest
      ? "We’ll email you a receipt for your request. Submitting a request does not require a card or take payment. If NIHO approves it, we’ll email you a Stripe payment link."
      : approval
        ? "You are charged only if they accept. We email you either way."
        : freeBooking
          ? "No payment is due. Your booking confirmation will arrive by email."
          : type
            ? "Your confirmation comes by email once your payment goes through."
            : "We email you about your booking. If the host needs to approve your request, the email says so.",
  };
}

/** Where a traveler who booked from the widget on a host's site goes back to (#638): that site's origin, read from the booking. */
export type BookingReturnBackTo = { readonly href: string; readonly host: string };

/** The words of the "back to the host's site" link on the return page. */
export function bookingReturnBackLabel(host: string, locale: "en" | "ja" = "en"): string {
  return locale === "ja" ? `${host} に戻る` : `Back to ${host}`;
}
