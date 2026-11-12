"use client";

import { useEffect, useRef, useState } from "react";
import { grantFromFragment, openBookingFromGrant } from "@/lib/guest-booking-page";
import { FindBookingForm } from "./FindBookingForm";
import { buttonClass } from "./ui";

type View =
  | { kind: "reading" }
  | { kind: "ready" }
  | { kind: "opening" }
  /** Unknown, expired or already used: the page does not say which. */
  | { kind: "closed" }
  | { kind: "failed" };

/**
 * `/bookings/open` (#285 slice 6, docs/guest-booking.md). The emails link to `/bookings/open#g=<grant>`: the grant is read
 * from the fragment, taken out of the address bar at once and kept in memory only. Nothing about the booking is shown or
 * fetched until the guest presses the button (a link scanner that runs the page opens nothing); then the grant is posted
 * to this site, which sets the booking's HttpOnly cookie, and the page goes to the booking.
 */
export function BookingOpen({ locale = "en" }: { locale?: "en" | "ja" }) {
  const ja = locale === "ja";
  const grant = useRef<string | null>(null);
  const [view, setView] = useState<View>({ kind: "reading" });

  useEffect(() => {
    // The grant leaves the address bar before anything else: not in history, a bookmark or a shared screenshot.
    grant.current = grantFromFragment(window.location.hash) ?? grant.current;
    if (window.location.hash) window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`);
    setView({ kind: grant.current ? "ready" : "closed" });
  }, []);

  async function open() {
    if (!grant.current || view.kind === "opening") return;
    setView({ kind: "opening" });
    const result = await openBookingFromGrant(grant.current);
    if (result.kind === "open") {
      grant.current = null;
      // A full load, so the server renders the booking with its new cookie; Back does not return here.
      window.location.replace(result.path);
      return;
    }
    if (result.kind === "closed") grant.current = null;
    setView({ kind: result.kind });
  }

  if (view.kind === "reading") {
    return (
      <div className="container-page max-w-2xl py-12" aria-busy="true" lang={ja ? "ja" : undefined}>
        <p role="status" className="text-ink-soft">{ja ? "開いています…" : "Opening…"}</p>
      </div>
    );
  }

  if (view.kind === "closed") {
    return (
      <div className="container-page max-w-2xl py-12" lang={ja ? "ja" : undefined}>
        <p className="hand text-[1.75rem]">{ja ? "このリンクは使えません" : "this link has closed"}</p>
        <h1 className="mt-1 text-3xl">{ja ? "このリンクはもう使えません" : <>This link can&apos;t be used any more</>}</h1>
        <p className="mt-3 text-ink-soft">
          {ja ? "メールのリンクは、期限内に1回だけご予約を開けます。新しいリンクをメールでお送りしますので、お申込みのメールアドレスを入力してください。" : "Each link in our emails opens your booking once, for a limited time. We can email you a new one: enter the address you booked with."}
        </p>
        <h2 className="mt-8 font-sans text-sm font-extrabold tracking-[0.04em] text-muted uppercase">{ja ? "新しいリンクを送る" : "Send me a new link"}</h2>
        <FindBookingForm submitLabel={ja ? "新しいリンクを送る" : "Send me a new link"} locale={locale} />
      </div>
    );
  }

  const failed = view.kind === "failed";
  return (
    <div className="container-page max-w-2xl py-12" lang={ja ? "ja" : undefined}>
      <p className="hand text-[1.75rem]">{failed ? (ja ? "うまくいきませんでした" : "something went wrong") : (ja ? "ご予約" : "your booking")}</p>
      <h1 className="mt-1 text-3xl">{failed ? (ja ? "ご予約を開けませんでした" : "We couldn't open your booking") : (ja ? "ご予約を開く" : "Open your booking")}</h1>
      <p className="mt-3 text-ink-soft">
        {failed
          ? (ja ? "しばらくしてから、もう一度お試しください。リンクはまだ使えます。" : "Please try again in a moment. Your link still works.")
          : (ja ? "この端末でご予約を開きます。メールのリンクは1回だけ使えます。新しいリンクはいつでも請求できます。" : "This opens your booking on this device. The link in your email works once; you can ask for a new one any time.")}
      </p>
      <button
        type="button"
        onClick={() => void open()}
        disabled={view.kind === "opening"}
        aria-busy={view.kind === "opening" || undefined}
        className={buttonClass("primary", "mt-6 w-full sm:w-auto")}
      >
        {view.kind === "opening" ? (ja ? "開いています…" : "Opening…") : failed ? (ja ? "もう一度試す" : "Try again") : (ja ? "ご予約を開く" : "Open your booking")}
      </button>
    </div>
  );
}
