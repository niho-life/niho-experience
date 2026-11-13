"use client";

import { useRef, useState } from "react";
import { cancelBooking, type BookingCancelChoice } from "@/lib/guest-booking-page";
import { Notice, buttonClass } from "./ui";

type Step = "idle" | "confirm" | "busy" | "changed" | "failed" | "conflict";

const TEXT: Record<BookingCancelChoice, { start: string; confirm: string; busy: string; question: string }> = {
  FULL_REFUND: {
    start: "Cancel and get a full refund",
    confirm: "Yes, cancel my booking",
    busy: "Cancelling…",
    question: "Cancel this booking? You can't undo this.",
  },
  REQUEST: {
    start: "Ask to cancel",
    confirm: "Send my request",
    busy: "Sending…",
    question: "Ask NIHO support to cancel this booking? Your booking stays confirmed until support replies.",
  },
};
const TEXT_JA: Record<BookingCancelChoice, { start: string; confirm: string; busy: string; question: string }> = {
  FULL_REFUND: { start: "キャンセルして全額返金を受ける", confirm: "はい、キャンセルします", busy: "キャンセル中…", question: "このご予約をキャンセルしますか？取り消すことはできません。" },
  REQUEST: { start: "キャンセルを依頼する", confirm: "依頼を送る", busy: "送信中…", question: "NIHO事務局にキャンセルを依頼しますか？事務局が返信するまで、ご予約は有効です。" },
};
const FREE_BOOKING_TEXT_JA = { start: "この無料のご予約をキャンセルする", confirm: "はい、キャンセルします", busy: "キャンセル中…", question: "この無料のご予約をキャンセルしますか？空きがあれば、あらためてご予約いただけます。" };
const FREE_BOOKING_TEXT = {
  start: "Cancel this free booking",
  confirm: "Yes, cancel my booking",
  busy: "Cancelling…",
  question: "Cancel this free booking? You can book again if places are available.",
};

/**
 * 取消 on the guest's booking page (#285 slice 7): one button, a confirmation step, then the page again (the server
 * draws the cancelled booking or the open request). `shownDeadlineUtc` is the deadline the page showed: when it no
 * longer holds, the server changes nothing and the page offers the current options. The command's UUID stays the same
 * for a retry after a lost answer, so a second press never cancels or refunds twice.
 */
export function BookingCancel({ publicBookingId, choice, shownDeadlineUtc, refundWords, freeBooking = false, locale = "en" }: {
  publicBookingId: string;
  choice: BookingCancelChoice;
  shownDeadlineUtc: string | null;
  /** What the confirmation says about the money ("We'll refund ¥7,500 in full …"); null for a request. */
  refundWords: string | null;
  freeBooking?: boolean;
  locale?: "en" | "ja";
}) {
  const ja = locale === "ja";
  const [step, setStep] = useState<Step>("idle");
  const commandId = useRef<string | null>(null);
  const text = ja ? (freeBooking ? FREE_BOOKING_TEXT_JA : TEXT_JA[choice]) : (freeBooking ? FREE_BOOKING_TEXT : TEXT[choice]);

  async function submit() {
    if (step === "busy") return;
    commandId.current ??= crypto.randomUUID();
    setStep("busy");
    const result = await cancelBooking({ publicBookingId, commandId: commandId.current, choice, shownDeadlineUtc });
    if (result.kind === "done" && result.outcome === "CHANGED") {
      setStep("changed");
      return;
    }
    if (result.kind === "done" || result.kind === "closed") {
      window.location.reload();
      return;
    }
    if (result.kind === "conflict") {
      commandId.current = null;
      setStep("conflict");
      return;
    }
    setStep("failed");
  }

  if (step === "changed") {
    return (
      <div role="alert">
        <Notice
          tone="warn"
          title={ja ? "このご予約のキャンセル条件が変わりました" : "This booking's cancellation options have changed"}
          action={<button type="button" onClick={() => window.location.reload()} className={buttonClass("secondary")}>{ja ? "現在の選択肢を表示する" : "Show the current options"}</button>}
        >
          {ja ? "このページを開いている間に無料キャンセルの受付が終了したため、キャンセルは行われていません。現在できることをご確認ください。" : "Free cancellation ended while this page was open, so nothing was cancelled. Here is what you can do now."}
        </Notice>
      </div>
    );
  }

  return (
    <div className="mt-4">
      {step === "failed" ? (
        <div role="alert" className="mb-4">
          <Notice tone="danger" title={ja ? "確認できませんでした。もう一度お試しください。" : "We couldn't confirm that. Please try again."}>
            {ja ? "もう一度送っても、二重にキャンセルや返金されることはありません。" : "Trying again is safe: it won't cancel or refund twice."}
          </Notice>
        </div>
      ) : null}
      {step === "conflict" ? (
        <div role="alert" className="mb-4">
          <Notice tone="danger" title={ja ? "状況が変わりました。ページを再読み込みして、もう一度お試しください。" : "Something changed. Please reload this page and try again."} />
        </div>
      ) : null}
      {step === "idle" || step === "conflict" ? (
        <button type="button" onClick={() => setStep("confirm")} className={buttonClass("secondary")}>{text.start}</button>
      ) : (
        <div className="rounded-2xl border border-line p-4">
          <p className="font-bold">{text.question}</p>
          {refundWords ? <p className="mt-1 text-[0.9375rem] text-ink-soft">{refundWords}</p> : null}
          <div className="mt-4 flex flex-wrap gap-3">
            <button type="button" onClick={() => void submit()} disabled={step === "busy"} aria-busy={step === "busy" || undefined} className={buttonClass("primary")}>
              {step === "busy" ? text.busy : text.confirm}
            </button>
            <button type="button" onClick={() => setStep("idle")} disabled={step === "busy"} className={buttonClass("ghost")}>{ja ? "予約を残す" : "Keep my booking"}</button>
          </div>
        </div>
      )}
    </div>
  );
}
