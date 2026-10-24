"use client";

import type { ExperienceConditionKind } from "@niho-experience/api-client";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  ACCESS_OPTIONS,
  CONDITION_KINDS,
  CONDITION_LABELS,
  conditionDraft,
  conditionSummary,
  DIET_OPTIONS,
  ENGLISH_LEVEL_OPTIONS,
  FOOD_SERVED_OPTIONS,
  RAIN_OPTIONS,
  SEATING_OPTIONS,
  WALKING_OPTIONS,
  withConditionFromDraft,
  withoutCondition,
  type ConditionDraft,
  type ConditionOption,
} from "@/host/conditions";
import { EDITOR_LIMITS } from "@/host/editor";
import type { HostParticipationConditions } from "@/host/types";
import { EditorPanel, FIELD_LABEL } from "./editor-parts";
import { INPUT } from "./fields";
import { consoleButtonClass } from "./host-ui";
import { HostIcon } from "./HostIcon";

/*
 * 参加の条件 (#110, the journey mock's H5 rows): one row per kind with its choices in one line (or
 * 未設定), opening a dialog like the offer's. The choices are shared by both tabs; the note is
 * written in the tab's language. NIHO writes the English the experience site shows from them; this
 * screen never writes that English, nor whether a guest must agree to it before booking.
 */

const GROUP_LABEL = `${FIELD_LABEL} mb-1.5 block`;

/** A choice as a chip: the invisible input covers it, like the offer dialog's days. */
const CHIP =
  "relative inline-flex min-h-9 items-center rounded-full border border-line-strong bg-canvas px-3.5 py-1 text-[0.8125rem] leading-snug font-extrabold text-ink-soft has-[:checked]:border-moss has-[:checked]:bg-leaf-pale has-[:checked]:text-moss has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-moss";
const CHIP_INPUT = "absolute inset-0 z-[1] m-0 size-full cursor-pointer appearance-none rounded-full opacity-0 focus-visible:outline-none";
const CHECK_ROW = "flex min-h-9 items-center gap-2 text-[0.8125rem] font-bold";
const CHECK = "size-5 shrink-0 accent-moss";

/** One choice of several (required: 保存 asks for it). */
function Choices<T extends string>({ legend, name, options, value, onChange }: { legend: string; name: string; options: readonly ConditionOption<T>[]; value: T | null; onChange: (value: T) => void }) {
  return (
    <fieldset className="min-w-0">
      <legend className={GROUP_LABEL}>{legend}</legend>
      <div className="flex flex-wrap gap-1.5">
        {options.map((option) => (
          <label key={option.value} className={CHIP}>
            <input type="radio" name={name} required value={option.value} checked={value === option.value} onChange={() => onChange(option.value)} className={CHIP_INPUT} />
            {option.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className={CHECK_ROW}>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.currentTarget.checked)} className={CHECK} />
      {label}
    </label>
  );
}

/** A whole number with its unit after it ("10 歳以上", "30 分"). */
function NumberField({ id, label, unit, hint, value, min, max, disabled = false, onChange }: { id: string; label: string; unit: string; hint?: string; value: string; min: number; max: number; disabled?: boolean; onChange: (value: string) => void }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className={FIELD_LABEL}>
        {label}
      </label>
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          step={1}
          value={value}
          disabled={disabled}
          aria-describedby={hint ? `${id}-hint` : undefined}
          onChange={(event) => onChange(event.currentTarget.value)}
          className={`${INPUT} max-w-28 disabled:bg-sand disabled:text-muted`}
        />
        <span className="text-[0.8125rem] font-bold text-ink-soft">{unit}</span>
      </div>
      {hint ? (
        <p id={`${id}-hint`} className="text-xs text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** The kind's own choices. */
function KindFields({ kind, draft, set, id }: { kind: ExperienceConditionKind; draft: ConditionDraft; set: (patch: Partial<ConditionDraft>) => void; id: (name: string) => string }) {
  switch (kind) {
    case "AGE":
      return (
        <>
          <NumberField id={id("age")} label="下限の年齢" unit="歳以上" hint="空欄は年齢の指定なしです" value={draft.minimumAge} min={1} max={99} onChange={(minimumAge) => set({ minimumAge })} />
          <Check label="子どもは大人と一緒に参加" checked={draft.withAdult} onChange={(withAdult) => set({ withAdult })} />
        </>
      );
    case "PHYSICAL":
      return (
        <>
          <Choices legend="座る" name={id("seating")} options={SEATING_OPTIONS} value={draft.seating} onChange={(seating) => set({ seating })} />
          <NumberField id={id("minutes")} label="座る時間の目安" unit="分" value={draft.seatedMinutes} min={1} max={600} disabled={draft.seating === null || draft.seating === "NONE"} onChange={(seatedMinutes) => set({ seatedMinutes })} />
          <Choices legend="歩く" name={id("walking")} options={WALKING_OPTIONS} value={draft.walking} onChange={(walking) => set({ walking })} />
        </>
      );
    case "HOST_LANGUAGE":
      return (
        <>
          <Check label="日本語を話す" checked={draft.japanese} onChange={(japanese) => set({ japanese })} />
          <Choices legend="英語" name={id("english")} options={ENGLISH_LEVEL_OPTIONS} value={draft.english} onChange={(english) => set({ english })} />
          <Check label="英語の案内資料あり" checked={draft.englishGuide} onChange={(englishGuide) => set({ englishGuide })} />
        </>
      );
    case "FOOD":
      return (
        <>
          <Choices legend="出るもの" name={id("served")} options={FOOD_SERVED_OPTIONS} value={draft.served} onChange={(served) => set({ served })} />
          <fieldset className="min-w-0">
            <legend className={GROUP_LABEL}>対応できる食事</legend>
            <div className="flex flex-wrap gap-1.5">
              {DIET_OPTIONS.map((option) => (
                <label key={option.value} className={CHIP}>
                  <input
                    type="checkbox"
                    checked={draft.diets.includes(option.value)}
                    onChange={(event) => set({ diets: event.currentTarget.checked ? [...draft.diets, option.value] : draft.diets.filter((diet) => diet !== option.value) })}
                    className={CHIP_INPUT}
                  />
                  {option.label}
                </label>
              ))}
            </div>
          </fieldset>
        </>
      );
    case "ACCESS":
      return <Choices legend="段差・車いす" name={id("access")} options={ACCESS_OPTIONS} value={draft.access} onChange={(access) => set({ access })} />;
    case "WEATHER":
      return <Choices legend="雨の日" name={id("rain")} options={RAIN_OPTIONS} value={draft.rain} onChange={(rain) => set({ rain })} />;
  }
}

/**
 * One kind in a modal dialog (the offer dialog's make): its choices and an optional note.
 * 保存 hands the conditions back to the page; the page's own 保存 keeps them. 未設定に戻す takes
 * the kind away (nothing is required).
 */
function HostConditionDialog({ kind, conditions, lang, onSave, onClose }: { kind: ExperienceConditionKind; conditions: HostParticipationConditions; lang: "ja" | "en"; onSave: (conditions: HostParticipationConditions) => void; onClose: () => void }) {
  const baseId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState<ConditionDraft>(() => conditionDraft(conditions, kind));
  const set = (patch: Partial<ConditionDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const id = (name: string) => `${baseId}-${name}`;
  const label = CONDITION_LABELS[kind];

  useEffect(() => {
    const element = dialog.current;
    // Opened once: removing the element when the dialog is done closes it without a "close" event.
    if (element && !element.open) element.showModal();
    element?.querySelector<HTMLElement>("input")?.focus();
  }, []);

  const close = () => dialog.current?.close();

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
          if (!event.currentTarget.reportValidity()) return;
          const next = withConditionFromDraft(conditions, kind, draft);
          if (!next) return;
          onSave(next);
          close();
        }}
      >
        <div className="flex items-center gap-2 border-b border-line py-1.5 pr-1.5 pl-4 md:pl-5">
          <h2 id={id("title")} className="min-w-0 flex-1 font-sans text-[0.9375rem] leading-normal font-extrabold tracking-normal">
            {label}
          </h2>
          <button type="button" aria-label="閉じる" onClick={close} className="grid size-10 shrink-0 place-items-center rounded-full text-ink-soft hover:bg-sand hover:text-ink">
            <HostIcon name="close" className="size-5" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4 md:px-5">
          <KindFields kind={kind} draft={draft} set={set} id={id} />
          <div className="flex min-w-0 flex-col gap-1.5">
            <label htmlFor={id("note")} className={FIELD_LABEL}>
              補足（任意）
            </label>
            <input id={id("note")} lang={lang} value={draft.note} maxLength={EDITOR_LIMITS.conditionNote} onChange={(event) => set({ note: event.currentTarget.value })} className={INPUT} />
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-4 py-3 md:px-5">
          {conditions[kind] ? (
            <button
              type="button"
              onClick={() => {
                onSave(withoutCondition(conditions, kind));
                close();
              }}
              className={consoleButtonClass("ghost", "md", "-ml-2 mr-auto")}
            >
              未設定に戻す
            </button>
          ) : null}
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

/**
 * 参加の条件 after 向かない人: a row per kind, 未設定 for one not set (none is required, and none
 * is needed to list the page). Used on the experience site's Good to know and before booking.
 */
export function HostConditionsPanel({ conditions, lang, marker, onChange }: { conditions: HostParticipationConditions; lang: "ja" | "en"; marker?: ReactNode; onChange: (conditions: HostParticipationConditions) => void }) {
  const [editing, setEditing] = useState<ExperienceConditionKind | null>(null);
  return (
    <EditorPanel id="editor-conditions" title="参加の条件" marker={marker}>
      <p className="-mt-1 mb-1 text-xs leading-normal text-muted">体験サイトの「Good to know」と予約の前の確認に出ます。英語の文は、選んだ内容から NIHO が作ります。</p>
      <ul className="-mb-1.5">
        {CONDITION_KINDS.map((kind) => {
          const value = conditions[kind];
          return (
            <li key={kind} className="border-t border-line first:border-t-0">
              <button type="button" onClick={() => setEditing(kind)} className="group flex min-h-12 w-full items-center gap-2.5 py-2.5 text-left">
                <span className="min-w-0 flex-1">
                  <span className="block text-[0.84375rem] font-extrabold">{CONDITION_LABELS[kind]}</span>
                  <span className={`block text-xs leading-normal [overflow-wrap:anywhere] ${value ? "text-ink-soft" : "text-muted"}`}>{conditionSummary(conditions, kind)}</span>
                  {value?.note ? (
                    <span lang={lang} className="block text-xs leading-normal text-muted [overflow-wrap:anywhere]">
                      {value.note}
                    </span>
                  ) : null}
                </span>
                <HostIcon name="chevronRight" className="size-4 text-line-strong group-hover:text-muted" />
              </button>
            </li>
          );
        })}
      </ul>
      {editing ? <HostConditionDialog kind={editing} conditions={conditions} lang={lang} onSave={onChange} onClose={() => setEditing(null)} /> : null}
    </EditorPanel>
  );
}
