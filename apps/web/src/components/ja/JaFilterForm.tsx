"use client";

import { useRef } from "react";
import { EXPERIENCE_AREAS, EXPERIENCE_COMPANIONS, EXPERIENCE_OCCASIONS, JA_GUEST_CHOICES, type JaListQuery } from "@/lib/ja-catalog";

const PILL = "inline-flex h-10 min-w-0 items-center gap-1 sm:min-w-40 rounded-full border border-line-strong bg-canvas pr-1 pl-3 text-[0.75rem] sm:text-[0.8125rem] text-ink-soft focus-within:outline-2 focus-within:outline-moss";
const SELECT = "min-w-0 flex-1 cursor-pointer appearance-none truncate bg-transparent py-2 pr-5 font-bold text-ink focus:outline-none";

/**
 * 日本語の一覧の絞り込み (#529): small round selects in one row (two columns on a phone). Choosing a value narrows the list
 * at once; without scripts the same GET form works with a 絞り込む button. The category and the day travel as hidden fields.
 */
export function JaFilterForm({ query }: { query: JaListQuery }) {
  const form = useRef<HTMLFormElement>(null);
  const submit = () => form.current?.requestSubmit();
  const select = (name: string, label: string, value: string, options: readonly (readonly [string, string])[]) => (
    <label className={PILL}>
      <span className="shrink-0">{label}</span>
      <span className="relative flex min-w-0 flex-1 items-center">
        <select name={name} defaultValue={value} onChange={submit} aria-label={label} className={SELECT}>
          <option value="">すべて</option>
          {options.map(([id, text]) => <option key={id} value={id}>{text}</option>)}
        </select>
        <svg aria-hidden="true" viewBox="0 0 20 20" className="pointer-events-none absolute right-1.5 size-3.5 text-muted" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m5 8 5 5 5-5" /></svg>
      </span>
    </label>
  );
  return (
    <form ref={form} method="get" action="/ja/experiences" className="mt-3 grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
      {query.category ? <input type="hidden" name="category" value={query.category} /> : null}
      {query.date ? <input type="hidden" name="date" value={query.date} /> : null}
      {select("area", "エリア", query.area ?? "", EXPERIENCE_AREAS.map((item) => [item.id, item.label] as const))}
      {select("with", "だれと", query.companion ?? "", EXPERIENCE_COMPANIONS.map((item) => [item.id, item.label] as const))}
      {select("occasion", "こんな日に", query.occasion ?? "", EXPERIENCE_OCCASIONS.map((item) => [item.id, item.label] as const))}
      {select("guests", "人数", query.guests ? String(query.guests) : "", JA_GUEST_CHOICES.map((value) => [String(value), `${value}人`] as const))}
      <noscript><button type="submit" className="col-span-2 inline-flex h-10 items-center justify-center rounded-full bg-leaf px-5 text-[0.875rem] font-extrabold text-ink">絞り込む</button></noscript>
    </form>
  );
}
