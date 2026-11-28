"use client";

import { useEffect, useRef, useState } from "react";
import { zoneName, zonedMoment } from "@/lib/booking-words";
import { zoneNameJa, zonedMomentJa } from "@/lib/booking-words-ja";
import { changeBookingDate, loadBookingChangeOptions, type BookingChangeOptionView } from "@/lib/guest-booking-page";
import { Notice, buttonClass } from "./ui";

type Step = "idle" | "loading" | "choose" | "confirm" | "busy";
/** Why the page says something above the dates: they changed, the date filled up, or something failed. */
type Note = null | "changed" | "full" | "failed" | "conflict" | "loadFailed";

/**
 * 予約の日時変更 (#720) on the guest's booking page: "Change date", then the dates of the same offer with room for the party
 * (read when the guest asks, never kept), one confirmation that says both dates, the same price and the new free
 * cancellation deadline, then the page again. What the page showed goes with the request: when it no longer holds, the
 * server changes nothing and the page shows the dates as they are now. The command's UUID stays the same for a retry after
 * a lost answer, so a second press never moves the booking twice.
 */
export function BookingChange({ publicBookingId, timeZone, locale = "en" }: { publicBookingId: string; timeZone: string; locale?: "en" | "ja" }) {
  const ja = locale === "ja";
  const [step, setStep] = useState<Step>("idle");
  const [note, setNote] = useState<Note>(null);
  const [blocked, setBlocked] = useState(false);
  const [fromStartUtc, setFromStartUtc] = useState<string | null>(null);
  const [options, setOptions] = useState<BookingChangeOptionView[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const commandId = useRef<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const when = (instant: string) => (ja ? `${zonedMomentJa(Date.parse(instant), timeZone)}（${zoneNameJa(timeZone)}）` : `${zonedMoment(Date.parse(instant), timeZone)} ${zoneName(timeZone)}`);
  const choice = options.find((option) => option.date === selected) ?? null;

  useEffect(() => {
    if (step === "choose" || step === "confirm") heading.current?.focus();
  }, [step]);

  async function load(nextNote: Note = null) {
    setStep("loading");
    const result = await loadBookingChangeOptions(publicBookingId);
    if (result.kind === "closed") {
      window.location.reload();
      return;
    }
    if (result.kind === "notChangeable") {
      setBlocked(true);
      setStep("idle");
      return;
    }
    if (result.kind === "failed") {
      setNote("loadFailed");
      setStep("idle");
      return;
    }
    setFromStartUtc(result.fromStartUtc);
    setOptions(result.options);
    setSelected((current) => (result.options.some((option) => option.date === current) ? current : null));
    setNote(nextNote);
    setStep("choose");
  }

  async function submit() {
    if (step === "busy" || !choice || !fromStartUtc) return;
    commandId.current ??= crypto.randomUUID();
    setStep("busy");
    const result = await changeBookingDate({
      publicBookingId, commandId: commandId.current, toDate: choice.date,
      shownFromStartUtc: fromStartUtc, shownToStartUtc: choice.startAtUtc, shownNewDeadlineUtc: choice.newDeadlineUtc,
    });
    if (result.kind === "closed" || (result.kind === "done" && result.outcome === "OK")) {
      window.location.reload();
      return;
    }
    if (result.kind === "failed") {
      setNote("failed");
      setStep("confirm");
      return;
    }
    commandId.current = null;
    if (result.kind === "conflict") {
      setSelected(null);
      await load("conflict");
      return;
    }
    if (result.outcome === "NOT_CHANGEABLE") {
      setBlocked(true);
      setStep("idle");
      return;
    }
    setSelected(null);
    await load(result.outcome === "FULL" ? "full" : "changed");
  }

  if (blocked) {
    return (
      <div role="status" className="mt-4">
        <Notice tone="neutral" title={ja ? "このご予約はここでは日付を変更できません" : "This booking can't be changed here"}>
          {ja ? "日付の変更をご希望の場合は、上の「ホストとのメッセージ」からご相談ください。" : "To ask about another date, write to your host in the messages above."}
        </Notice>
      </div>
    );
  }

  const notice = note === "changed" ? (ja ? "日程の空きが変わりました。今選べる日付から選び直してください。" : "The dates changed while this page was open. Please choose from the dates open now.")
    : note === "full" ? (ja ? "その日はいっぱいになりました。別の日付をお選びください。" : "That date just filled up. Please choose another.")
      : note === "conflict" ? (ja ? "状況が変わりました。もう一度お選びください。" : "Something changed. Please choose again.")
        : note === "loadFailed" ? (ja ? "日付を読み込めませんでした。もう一度お試しください。" : "We couldn't load the dates. Please try again.")
          : note === "failed" ? (ja ? "確認できませんでした。もう一度お試しください。二重に変更されることはありません。" : "We couldn't confirm that. Please try again: it won't change your booking twice.")
            : null;
  const alert = notice ? (
    <div role="alert" className="mb-4">
      <Notice tone={note === "failed" || note === "loadFailed" ? "danger" : "warn"} title={notice} />
    </div>
  ) : null;

  if (step === "idle" || step === "loading") {
    return (
      <div className="mt-4">
        {alert}
        <button type="button" onClick={() => void load()} disabled={step === "loading"} aria-busy={step === "loading" || undefined} className={buttonClass("secondary")}>
          {step === "loading" ? (ja ? "読み込み中…" : "Loading…") : (ja ? "日付を変更する" : "Change date")}
        </button>
      </div>
    );
  }

  if (step === "choose") {
    return (
      <div className="mt-4">
        {alert}
        <fieldset className="rounded-2xl border border-line p-4">
          <legend className="sr-only">{ja ? "新しい日付" : "New date"}</legend>
          <h3 ref={heading} tabIndex={-1} className="font-bold outline-none">{ja ? "新しい日付を選んでください" : "Choose a new date"}</h3>
          {options.length === 0 ? (
            <p className="mt-2 text-[0.9375rem] text-ink-soft">{ja ? "今は、ほかに空きのある日付がありません。" : "No other dates are open right now."}</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {options.map((option) => (
                <li key={option.date}>
                  <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-line p-3 has-[:checked]:border-ink">
                    <input type="radio" name={`change-${publicBookingId}`} value={option.date} checked={selected === option.date} onChange={() => { if (selected !== option.date) commandId.current = null; setSelected(option.date); }} className="mt-1" />
                    <span className="min-w-0 [overflow-wrap:anywhere]">
                      <span className="block font-bold">{when(option.startAtUtc)}</span>
                      <span className="block text-[0.875rem] text-ink-soft">
                        {ja ? `残り${option.seatsLeft}席・${when(option.newDeadlineUtc)}まで無料キャンセル` : `${option.seatsLeft} ${option.seatsLeft === 1 ? "place" : "places"} left · Free cancellation until ${when(option.newDeadlineUtc)}`}
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-4 flex flex-wrap gap-3">
            <button type="button" onClick={() => setStep("confirm")} disabled={!choice} className={buttonClass("primary")}>{ja ? "次へ" : "Continue"}</button>
            <button type="button" onClick={() => { setNote(null); setStep("idle"); }} className={buttonClass("ghost")}>{ja ? "今の日付のままにする" : "Keep my date"}</button>
          </div>
        </fieldset>
      </div>
    );
  }

  // confirm / busy
  return (
    <div className="mt-4">
      {alert}
      <div className="rounded-2xl border border-line p-4">
        <h3 ref={heading} tabIndex={-1} className="font-bold outline-none">{ja ? "この日付に変更しますか？" : "Change to this date?"}</h3>
        {choice && fromStartUtc ? (
          <p className="mt-2 text-[0.9375rem] [overflow-wrap:anywhere]">
            {ja
              ? `ご予約を${when(fromStartUtc)}から${when(choice.startAtUtc)}に変更します。料金は変わりません。${when(choice.newDeadlineUtc)}まで無料でキャンセルできます。`
              : `Your booking moves from ${when(fromStartUtc)} to ${when(choice.startAtUtc)}. The price doesn't change. You can cancel for free until ${when(choice.newDeadlineUtc)}.`}
          </p>
        ) : null}
        <div className="mt-4 flex flex-wrap gap-3">
          <button type="button" onClick={() => void submit()} disabled={step === "busy"} aria-busy={step === "busy" || undefined} className={buttonClass("primary")}>
            {step === "busy" ? (ja ? "変更中…" : "Changing…") : (ja ? "日付を変更する" : "Change my date")}
          </button>
          <button type="button" onClick={() => { setNote(null); setStep("choose"); }} disabled={step === "busy"} className={buttonClass("ghost")}>{ja ? "戻る" : "Back"}</button>
        </div>
      </div>
    </div>
  );
}
