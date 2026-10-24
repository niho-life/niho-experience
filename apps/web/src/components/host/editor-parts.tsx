"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { HOST_SURFACE } from "./host-ui";
import { HostIcon } from "./HostIcon";
import { SectionTitle } from "./ui";

/*
 * Small parts of the experience editor (#89, mock v2 `.sect` `.li` `.addrow`). Inputs are
 * 16px on phones (iOS does not zoom in) and 14px from md up, like fields.tsx.
 */

/** A row of a list (見どころ, 注意事項…): sand until focused, then white with the field's line. */
const LIST_INPUT_BASE = "block min-h-10 min-w-0 rounded-[10px] border border-transparent bg-sand px-3 py-2 text-[1rem] leading-normal focus:border-line-strong focus:bg-canvas md:text-[0.875rem]";
export const LIST_INPUT = `${LIST_INPUT_BASE} w-full text-ink`;
/** The second line of a row (当日の流れ's 一言). */
export const LIST_INPUT_SUB = `${LIST_INPUT_BASE} w-full text-ink-soft`;
export const LIST_INPUT_TIME = `${LIST_INPUT_BASE} w-[72px] shrink-0 text-ink tabular-nums md:w-[84px]`;

/** Labels above a field inside a panel (集合場所, the offer dialog). */
export const FIELD_LABEL = "text-[0.78125rem] font-extrabold text-ink-soft";

/** A label inside a panel that is a heading of its own (含まれるもの). */
export const SUB_HEADING = "mb-2 font-sans text-[0.78125rem] leading-normal font-extrabold tracking-normal text-ink-soft";

/** Disabled buttons fade and ignore the pointer. */
export const DISABLED = "disabled:pointer-events-none disabled:opacity-45";

const ADD_ROW = "inline-flex h-8 items-center gap-1 rounded-full text-[0.8125rem] font-extrabold text-moss hover:underline hover:underline-offset-4";

/**
 * One section of the editor in its own panel, with its actions on the right of the title. `marker`
 * sits next to the title (日本語を変えました on the English tab, #110).
 */
export function EditorPanel({ id, title, marker, actions, children }: { id: string; title: string; marker?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className={`${HOST_SURFACE} p-4 md:px-5 md:py-[18px]`}>
      <div className="mb-3 flex min-h-[30px] flex-wrap items-center justify-between gap-2.5">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <SectionTitle id={id}>{title}</SectionTitle>
          {marker}
        </div>
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

/** Moves focus once React has drawn a change (a row added or removed, a photo moved). */
export function useFocusAfterRender(): (id: string) => void {
  const pending = useRef<string | null>(null);
  useEffect(() => {
    if (pending.current === null) return;
    document.getElementById(pending.current)?.focus();
    pending.current = null;
  });
  return (id: string) => {
    pending.current = id;
  };
}

export function RemoveButton({ id, label, onClick }: { id?: string; label: string; onClick: () => void }) {
  return (
    <button id={id} type="button" aria-label={label} onClick={onClick} className="grid size-8 shrink-0 place-items-center rounded-lg text-muted hover:bg-sand hover:text-ink">
      <HostIcon name="close" className="size-4" />
    </button>
  );
}

/** "＋ 行を足す" under a list. `context` names the list for screen readers ("見どころに行を足す"). */
export function AddRowButton({ id, context, label, onClick }: { id?: string; context?: string; label: string; onClick: () => void }) {
  return (
    <button id={id} type="button" aria-label={context ? `${context}に${label}` : undefined} onClick={onClick} className={ADD_ROW}>
      <HostIcon name="plus" className="size-3.5" />
      {label}
    </button>
  );
}

/**
 * A list of one-line texts (見どころ, 含まれるもの, 注意事項…): a row per item with ×, and
 * "＋ 行を足す" until the list is full. `lang` is the rows' language (English on the English tab).
 */
export function TextList({ label, values, max, maxLength, lang, onChange }: { label: string; values: readonly string[]; max: number; maxLength: number; lang?: string; onChange: (values: string[]) => void }) {
  const baseId = useId();
  const focusLater = useFocusAfterRender();
  const add = () => {
    focusLater(`${baseId}-${values.length}`);
    onChange([...values, ""]);
  };
  const remove = (index: number) => {
    const left = values.length - 1;
    focusLater(left > 0 ? `${baseId}-${Math.min(index, left - 1)}` : `${baseId}-add`);
    onChange(values.filter((_, other) => other !== index));
  };
  return (
    <div className="flex flex-col items-start gap-2">
      {values.length ? (
        <ul className="flex w-full flex-col gap-2">
          {values.map((value, index) => (
            <li key={index} className="flex items-center gap-2">
              <input
                id={`${baseId}-${index}`}
                aria-label={`${label} ${index + 1}`}
                lang={lang}
                value={value}
                maxLength={maxLength}
                onChange={(event) => {
                  const text = event.currentTarget.value;
                  onChange(values.map((item, other) => (other === index ? text : item)));
                }}
                className={LIST_INPUT}
              />
              <RemoveButton label={`${label} ${index + 1} を削除`} onClick={() => remove(index)} />
            </li>
          ))}
        </ul>
      ) : null}
      {values.length < max ? <AddRowButton id={`${baseId}-add`} context={label} label="行を足す" onClick={add} /> : <p className="text-xs text-muted">{max}行までです</p>}
    </div>
  );
}
