"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { HostInfoTip } from "./HostInfoTip";

/* Small inputs of the host editor (体験の編集): fields that put their explanation behind an 「i」, rows, switches, and a plain dialog. */

export const EDITOR_INPUT = "block w-full min-h-10 rounded-[10px] border border-line-strong bg-canvas px-3 py-2 text-[1rem] leading-[1.6] text-ink outline-none focus-visible:border-moss focus-visible:ring-2 focus-visible:ring-moss/20 md:text-[0.875rem]";
const ROW_INPUT = "block w-full min-h-10 rounded-[10px] border border-transparent bg-sand px-3 py-2 text-[1rem] leading-[1.6] text-ink outline-none focus-visible:border-moss focus-visible:bg-canvas focus-visible:ring-2 focus-visible:ring-moss/20 md:text-[0.875rem]";

/** The other language's text under a field, read only (見比べる). */
export function EditorReference({ language, text }: { language: string; text: string }) {
  return <p className="mt-1.5 border-l-2 border-line pl-2.5 text-[0.78125rem] whitespace-pre-line text-muted"><b className="mr-2 text-[0.6875rem] text-ink-soft">{language}</b>{text.trim() ? text : "（未入力）"}</p>;
}

export function EditorLabel({ htmlFor, label, small, info }: { htmlFor?: string; label: string; small?: string; info?: string }) {
  return (
    <div className="mb-1 flex items-center">
      <label htmlFor={htmlFor} className="text-[0.8125rem] font-bold text-ink-soft">{label}{small ? <small className="ml-1.5 text-xs font-normal text-muted">{small}</small> : null}</label>
      {info ? <HostInfoTip label={label}>{info}</HostInfoTip> : null}
    </div>
  );
}

export function EditorField({ label, small, info, value, onChange, rows, placeholder, inputMode, reference, invalid = false, className = "" }: {
  label: string; small?: string; info?: string; value: string; onChange: (value: string) => void; rows?: number; placeholder?: string;
  inputMode?: "numeric" | "decimal"; reference?: ReactNode; invalid?: boolean; className?: string;
}) {
  const id = useId();
  const tone = invalid ? " border-warn bg-warn-pale" : "";
  return (
    <div className={`mt-3.5 first:mt-0 ${className}`.trim()}>
      <EditorLabel htmlFor={id} label={label} small={small} info={info} />
      {rows ? <textarea id={id} rows={rows} value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} className={`${EDITOR_INPUT} resize-y${tone}`} />
        : <input id={id} value={value} placeholder={placeholder} inputMode={inputMode} onChange={(event) => onChange(event.target.value)} className={`${EDITOR_INPUT}${tone}`} />}
      {reference}
    </div>
  );
}

/** A heading of a group of rows, with its explanation behind an 「i」. */
export function EditorSubheading({ id, label, small, info }: { id?: string; label: string; small?: string; info?: string }) {
  return (
    <p id={id} className="mt-5 mb-1.5 flex items-center text-[0.84375rem] font-extrabold first:mt-0">{label}{small ? <small className="ml-1.5 text-xs font-normal text-muted">{small}</small> : null}{info ? <HostInfoTip label={label}>{info}</HostInfoTip> : null}</p>
  );
}

/** One line per row: an input, 「×」, and 「＋ 行を足す」. The caller drops empty rows when saving. */
export function EditorRows({ label, values, onChange, disabled, small, info, references, language }: {
  label: string; values: readonly string[]; onChange: (values: string[]) => void; disabled?: boolean; small?: string; info?: string;
  /** The other language's rows, read only under each row. */ references?: readonly string[]; language?: string;
}) {
  const headingId = useId();
  const focusLast = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focusLast.current) return;
    focusLast.current = false;
    const inputs = root.current?.querySelectorAll("input");
    inputs?.[inputs.length - 1]?.focus();
  }, [values.length]);
  return (
    <div role="group" aria-labelledby={headingId} ref={root}>
      <EditorSubheading id={headingId} label={label} small={small} info={info} />
      <div className="grid gap-1.5">
        {values.map((value, index) => (
          <div key={index}>
            <div className="grid grid-cols-[1fr_34px] items-start gap-1.5">
              <input aria-label={`${label} ${index + 1}`} value={value} disabled={disabled} onChange={(event) => onChange(values.map((item, at) => at === index ? event.target.value : item))}
                onKeyDown={(event) => {
                  // Enter moves on (a new row after the last one) instead of saving the form; a conversion being confirmed is left alone.
                  // Safari reports the Enter that confirms an IME conversion as keyCode 229 with isComposing already false.
                  if (event.key !== "Enter" || event.nativeEvent.isComposing || event.keyCode === 229) return;
                  event.preventDefault();
                  if (index === values.length - 1) { focusLast.current = true; onChange([...values, ""]); return; }
                  root.current?.querySelectorAll("input")[index + 1]?.focus();
                }}
                className={ROW_INPUT} />
              <button type="button" disabled={disabled} aria-label={`${label} ${index + 1} を削除`} onClick={() => onChange(values.filter((_, at) => at !== index))} className="h-10 w-[34px] rounded-[9px] text-[1.0625rem] text-muted hover:bg-sand hover:text-ink">×</button>
            </div>
            {references && language && references[index] !== undefined ? <EditorReference language={language} text={references[index]!} /> : null}
          </div>
        ))}
        <button type="button" disabled={disabled} onClick={() => { focusLast.current = true; onChange([...values, ""]); }} className="justify-self-start px-0.5 py-1.5 text-[0.8125rem] font-extrabold text-moss">＋ 行を足す</button>
      </div>
    </div>
  );
}

export function EditorSwitch({ label, checked, onChange, disabled, info }: { label: string; checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean; info?: string }) {
  return (
    <div className="mt-4 flex items-center">
      <label className="flex cursor-pointer items-center gap-2.5 text-[0.84375rem] font-bold text-ink">
        <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} className="peer sr-only" />
        <span aria-hidden="true" className="relative h-[22px] w-[38px] shrink-0 rounded-full bg-line-strong transition-colors peer-checked:bg-moss peer-focus-visible:outline-3 peer-focus-visible:outline-moss after:absolute after:top-0.5 after:left-0.5 after:size-[18px] after:rounded-full after:bg-canvas after:transition-transform peer-checked:after:translate-x-4" />
        {label}
      </label>
      {info ? <HostInfoTip label={label}>{info}</HostInfoTip> : null}
    </div>
  );
}

/** A group of radio cards (掲載言語, 集合場所を見せる時期, 取消条件). */
export function EditorChoice<T extends string>({ legend, legendHidden = false, info, value, options, onChange, disabled, name }: {
  /** `legendHidden`: the section heading above already names the group, so the legend is for screen readers only. */
  legend: string; legendHidden?: boolean; info?: string; value: T; options: readonly { value: T; label: string; detail?: string }[]; onChange: (value: T) => void; disabled?: boolean; name: string;
}) {
  return (
    <fieldset className="mt-3.5 min-w-0 first:mt-0">
      <legend className={legendHidden ? "sr-only" : "mb-1 flex items-center p-0 text-[0.8125rem] font-bold text-ink-soft"}>{legend}{info ? <HostInfoTip label={legend}>{info}</HostInfoTip> : null}</legend>
      <div className="grid gap-2">
        {options.map((option) => (
          <label key={option.value} className={`flex cursor-pointer items-center gap-2.5 rounded-xl border px-3.5 py-2.5 ${value === option.value ? "border-ink bg-sand" : "border-line-strong"}`}>
            <input type="radio" name={name} value={option.value} checked={value === option.value} disabled={disabled} onChange={() => onChange(option.value)} className="accent-moss" />
            <span><b className="block text-[0.84375rem]">{option.label}</b>{option.detail ? <span className="block text-[0.78125rem] text-ink-soft">{option.detail}</span> : null}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export const EDITOR_DIALOG = "m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-[460px] overflow-y-auto rounded-2xl border-0 bg-canvas p-0 text-[0.875rem] leading-[1.6] text-ink shadow-[0_20px_60px_rgb(0_0_0/0.2)] backdrop:bg-ink/40";

/** A modal <dialog> the page opens and closes with `open`. Esc and the backdrop-less close call `onClose`. Its content is only rendered while open. */
export function EditorDialog({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);
  return (
    <dialog ref={dialog} aria-labelledby={titleId} onClose={onClose} className={EDITOR_DIALOG}>
      {open ? <div className="px-4 py-4 md:px-5 md:py-5"><h2 id={titleId} className="mb-1 font-sans text-[1.0625rem] font-extrabold">{title}</h2>{children}</div> : null}
    </dialog>
  );
}

const UNIT_INPUT = "block min-h-10 rounded-[10px] border border-line-strong bg-canvas px-3 py-2 text-right text-[1rem] leading-[1.6] tabular-nums text-ink outline-none focus-visible:border-moss focus-visible:ring-2 focus-visible:ring-moss/20 md:text-[0.875rem]";

/** A number with its unit beside it (¥, 人, 歳, %). `to` makes a range: two inputs joined by 〜. */
export function EditorUnitField({ label, small, info, prefix, suffix, value, onChange, to, inputMode = "numeric", width = "w-[120px]", placeholder }: {
  label: string; small?: string; info?: string; prefix?: string; suffix?: string; value: string; onChange: (value: string) => void;
  to?: { label: string; value: string; onChange: (value: string) => void }; inputMode?: "numeric" | "decimal"; width?: string; placeholder?: string;
}) {
  const id = useId();
  const half = to ? "w-[72px]" : width;
  return (
    <div className="mt-3.5 first:mt-0">
      <EditorLabel htmlFor={id} label={label} small={small} info={info} />
      <div className="flex items-center gap-2 text-[0.8125rem] text-ink-soft">
        {prefix ? <span>{prefix}</span> : null}
        <input id={id} value={value} inputMode={inputMode} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} className={`${UNIT_INPUT} ${half}`} />
        {to ? <><span>〜</span><input aria-label={to.label} value={to.value} inputMode={inputMode} onChange={(event) => to.onChange(event.target.value)} className={`${UNIT_INPUT} ${half}`} /></> : null}
        {suffix ? <span>{suffix}</span> : null}
      </div>
    </div>
  );
}
