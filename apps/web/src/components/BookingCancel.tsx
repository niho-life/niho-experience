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

/**
 * 取消 on the guest's booking page (#285 slice 7): one button, a confirmation step, then the page again (the server
 * draws the cancelled booking or the open request). `shownDeadlineUtc` is the deadline the page showed: when it no
 * longer holds, the server changes nothing and the page offers the current options. The command's UUID stays the same
 * for a retry after a lost answer, so a second press never cancels or refunds twice.
 */
export function BookingCancel({ publicBookingId, choice, shownDeadlineUtc, refundWords }: {
  publicBookingId: string;
  choice: BookingCancelChoice;
  shownDeadlineUtc: string | null;
  /** What the confirmation says about the money ("We'll refund ¥7,500 in full …"); null for a request. */
  refundWords: string | null;
}) {
  const [step, setStep] = useState<Step>("idle");
  const commandId = useRef<string | null>(null);
  const text = TEXT[choice];

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
          title="This booking's cancellation options have changed"
          action={<button type="button" onClick={() => window.location.reload()} className={buttonClass("secondary")}>Show the current options</button>}
        >
          Free cancellation ended while this page was open, so nothing was cancelled. Here is what you can do now.
        </Notice>
      </div>
    );
  }

  return (
    <div className="mt-4">
      {step === "failed" ? (
        <div role="alert" className="mb-4">
          <Notice tone="danger" title="We couldn't confirm that. Please try again.">
            Trying again is safe: it won&apos;t cancel or refund twice.
          </Notice>
        </div>
      ) : null}
      {step === "conflict" ? (
        <div role="alert" className="mb-4">
          <Notice tone="danger" title="Something changed. Please reload this page and try again." />
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
            <button type="button" onClick={() => setStep("idle")} disabled={step === "busy"} className={buttonClass("ghost")}>Keep my booking</button>
          </div>
        </div>
      )}
    </div>
  );
}
