"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { EDITOR_LIMITS, offerDraft, offerFromDraft, WEEKDAYS_FROM_MONDAY, weekdayLabel, type OfferDraft } from "@/host/editor";
import { dateWithWeekdayJa } from "@/host/format";
import type { HostOffer, Weekday } from "@/host/types";
import { AddRowButton, DISABLED, FIELD_LABEL, LIST_INPUT, RemoveButton, useFocusAfterRender } from "./editor-parts";
import { INPUT } from "./fields";
import { consoleButtonClass } from "./host-ui";
import { HostIcon } from "./HostIcon";

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={htmlFor} className={FIELD_LABEL}>
        {label}
      </label>
      {children}
    </div>
  );
}

const GROUP_LABEL = `${FIELD_LABEL} mb-1.5 block`;

/** A text-only button in the danger color (the ghost button's shape). */
const DANGER_BUTTON = "-ml-2 mr-auto inline-flex h-[38px] shrink-0 items-center rounded-full px-4 text-[0.84375rem] leading-none font-extrabold whitespace-nowrap text-danger hover:bg-danger-pale";

/** "12月31日（木）", with the year when it is not this year's ("2027年1月1日（金）"). */
function dayOffLabel(date: string, today: string): string {
  return date.slice(0, 4) === today.slice(0, 4) ? dateWithWeekdayJa(date) : `${date.slice(0, 4)}年${dateWithWeekdayJa(date)}`;
}

/**
 * One offer of 申込の設定 in a modal dialog (mock v2 `.offer`): name, prices, capacity,
 * start, length, the days it runs, days off and the questions asked when booking.
 * 保存 here hands the offer back to the page; the page's own 保存 keeps it. Only the
 * name is required: what a listing still needs shows in 掲載までに必要. The name and the
 * questions are in `lang`, the tab's language (#110); the rest is shared by both tabs.
 */
export function HostOfferDialog({ offer, isNew, today, lang = "en", onSave, onDelete, onClose }: { offer: HostOffer; isNew: boolean; today: string; lang?: "ja" | "en"; onSave: (offer: HostOffer) => void; onDelete: () => void; onClose: () => void }) {
  const baseId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const firstField = useRef<HTMLInputElement>(null);
  const focusLater = useFocusAfterRender();
  const [draft, setDraft] = useState<OfferDraft>(() => offerDraft(offer));
  const [dayOff, setDayOff] = useState("");
  const set = (patch: Partial<OfferDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const id = (name: string) => `${baseId}-${name}`;

  useEffect(() => {
    const element = dialog.current;
    // Opened once: removing the element when the dialog is done closes it without a "close" event.
    if (element && !element.open) element.showModal();
    firstField.current?.focus();
  }, []);

  const close = () => dialog.current?.close();
  const toggleDay = (day: Weekday) => set({ weekdays: draft.weekdays.includes(day) ? draft.weekdays.filter((other) => other !== day) : [...draft.weekdays, day] });
  const addDayOff = () => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dayOff) || dayOff < today) return;
    set({ closedDates: [...new Set([...draft.closedDates, dayOff])].sort() });
    setDayOff("");
  };
  const questions = EDITOR_LIMITS.questions;
  const removeQuestion = (index: number) => {
    const left = draft.questions.length - 1;
    focusLater(left > 0 ? id(`question-${Math.min(index, left - 1)}`) : id("question-add"));
    set({ questions: draft.questions.filter((_, other) => other !== index) });
  };

  return (
    <dialog
      ref={dialog}
      aria-labelledby={id("title")}
      onClose={onClose}
      className="m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-[480px] overflow-hidden rounded-2xl border-0 bg-canvas p-0 text-[0.875rem] leading-[1.6] text-ink shadow-[0_20px_60px_rgb(0_0_0/0.2)] backdrop:bg-ink/40"
    >
      <form
        className="flex max-h-[calc(100dvh-2rem)] flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          firstField.current?.setCustomValidity(draft.name.trim() ? "" : "商品名は空白以外で入力してください。");
          if (!event.currentTarget.reportValidity()) return;
          onSave(offerFromDraft(offer.id, draft));
          close();
        }}
      >
        <div className="flex items-center gap-2 border-b border-line py-1.5 pr-1.5 pl-4 md:pl-5">
          <h2 id={id("title")} className="min-w-0 flex-1 font-sans text-[0.9375rem] leading-normal font-extrabold tracking-normal">
            {isNew ? "商品の追加" : "商品の編集"}
          </h2>
          <button type="button" aria-label="閉じる" onClick={close} className="grid size-10 shrink-0 place-items-center rounded-full text-ink-soft hover:bg-sand hover:text-ink">
            <HostIcon name="close" className="size-5" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4 md:px-5">
          <Field label="商品名" htmlFor={id("name")}>
            <input
              ref={firstField}
              id={id("name")}
              lang={lang}
              required
              maxLength={EDITOR_LIMITS.offerName}
              value={draft.name}
              placeholder={lang === "en" ? "例: Dinner" : "例: ディナー"}
              onChange={(event) => {
                const name = event.currentTarget.value;
                event.currentTarget.setCustomValidity(name.trim() ? "" : "商品名は空白以外で入力してください。");
                set({ name });
              }}
              className={INPUT}
            />
          </Field>
          <div className="grid grid-cols-2 items-end gap-3">
            <Field label="大人の料金（円）" htmlFor={id("adult")}>
              <input id={id("adult")} type="number" inputMode="numeric" min={0} step={1} value={draft.adultPrice} onChange={(event) => set({ adultPrice: event.currentTarget.value })} className={INPUT} />
            </Field>
            <Field label="子どもの料金（任意・円）" htmlFor={id("child")}>
              <input id={id("child")} type="number" inputMode="numeric" min={0} step={1} value={draft.childPrice} onChange={(event) => set({ childPrice: event.currentTarget.value })} className={INPUT} />
            </Field>
          </div>
          <div className="grid grid-cols-2 items-end gap-3">
            <Field label="定員（名）" htmlFor={id("capacity")}>
              <input id={id("capacity")} type="number" inputMode="numeric" min={1} max={99} step={1} value={draft.capacity} onChange={(event) => set({ capacity: event.currentTarget.value })} className={INPUT} />
            </Field>
            <Field label="所要時間（分）" htmlFor={id("duration")}>
              <input id={id("duration")} type="number" inputMode="numeric" min={5} max={1440} step={5} value={draft.duration} onChange={(event) => set({ duration: event.currentTarget.value })} className={INPUT} />
            </Field>
          </div>
          <Field label="開始時刻" htmlFor={id("start")}>
            <input id={id("start")} type="time" value={draft.startTime} onChange={(event) => set({ startTime: event.currentTarget.value })} className={`${INPUT} md:max-w-[180px]`} />
          </Field>

          <fieldset className="min-w-0">
            <legend className={GROUP_LABEL}>開催曜日</legend>
            <div className="grid grid-cols-7 gap-1">
              {WEEKDAYS_FROM_MONDAY.map((day) => (
                <label
                  key={day}
                  className="relative grid h-9 place-items-center rounded-full border border-line-strong bg-canvas text-[0.8125rem] font-extrabold text-ink-soft has-[:checked]:border-moss has-[:checked]:bg-leaf-pale has-[:checked]:text-moss has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-moss"
                >
                  {/* The invisible checkbox covers its whole chip, like the booking date cards. */}
                  <input type="checkbox" checked={draft.weekdays.includes(day)} onChange={() => toggleDay(day)} className="absolute inset-0 size-full cursor-pointer appearance-none rounded-full opacity-0 focus-visible:outline-none" />
                  {weekdayLabel(day)}
                </label>
              ))}
            </div>
          </fieldset>

          <div role="group" aria-labelledby={id("days-off")}>
            <span id={id("days-off")} className={GROUP_LABEL}>
              休みの日
            </span>
            {draft.closedDates.length ? (
              <ul className="mb-2 flex flex-wrap gap-1.5">
                {draft.closedDates.map((date) => (
                  <li key={date} className="inline-flex h-8 items-center gap-0.5 rounded-full bg-sand pr-1 pl-3 text-[0.8125rem] font-bold">
                    {dayOffLabel(date, today)}
                    <button type="button" aria-label={`${dayOffLabel(date, today)}を外す`} onClick={() => set({ closedDates: draft.closedDates.filter((other) => other !== date) })} className="grid size-6 place-items-center rounded-full text-muted hover:bg-canvas hover:text-ink">
                      <HostIcon name="close" className="size-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="flex items-center gap-2">
              <input
                type="date"
                aria-label="休みにする日"
                min={today}
                value={dayOff}
                onChange={(event) => setDayOff(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  addDayOff();
                }}
                className={`${INPUT} min-w-0 flex-1 md:max-w-[200px]`}
              />
              <button type="button" onClick={addDayOff} disabled={!dayOff} className={consoleButtonClass("secondary", "sm", DISABLED)}>
                追加
              </button>
            </div>
          </div>

          <div role="group" aria-labelledby={id("questions")}>
            <span id={id("questions")} className={GROUP_LABEL}>
              申込時の質問（任意）
            </span>
            <div className="flex flex-col items-start gap-2">
              {draft.questions.length ? (
                <ul className="flex w-full flex-col gap-2">
                  {draft.questions.map((question, index) => (
                    <li key={index} className="flex items-center gap-2">
                      <input
                        id={id(`question-${index}`)}
                        aria-label={`申込時の質問 ${index + 1}`}
                        lang={lang}
                        value={question}
                        maxLength={questions.length}
                        onChange={(event) => {
                          const text = event.currentTarget.value;
                          set({ questions: draft.questions.map((item, other) => (other === index ? text : item)) });
                        }}
                        className={LIST_INPUT}
                      />
                      <RemoveButton label={`申込時の質問 ${index + 1} を削除`} onClick={() => removeQuestion(index)} />
                    </li>
                  ))}
                </ul>
              ) : null}
              {draft.questions.length < questions.items ? (
                <AddRowButton
                  id={id("question-add")}
                  label="質問を足す"
                  onClick={() => {
                    focusLater(id(`question-${draft.questions.length}`));
                    set({ questions: [...draft.questions, ""] });
                  }}
                />
              ) : (
                <p className="text-xs text-muted">質問は{questions.items}つまでです</p>
              )}
            </div>
          </div>
        </div>

        {/* On a narrow phone the delete button keeps its own row; キャンセル and 保存 stay together on the right. */}
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-4 py-3 md:px-5">
          {isNew ? null : (
            <button
              type="button"
              onClick={() => {
                onDelete();
                close();
              }}
              className={DANGER_BUTTON}
            >
              この商品を削除
            </button>
          )}
          <div className="flex gap-2">
            <button type="button" onClick={close} className={consoleButtonClass("secondary")}>
              キャンセル
            </button>
            <button type="submit" className={consoleButtonClass("primary")}>
              保存
            </button>
          </div>
        </div>
      </form>
    </dialog>
  );
}
