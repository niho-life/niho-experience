"use client";

import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { Occurrence } from "@niho-experience/api-client";
import type { CardOffer } from "@/lib/card-model";
import { availableDays, MAX_GUESTS, windowDayKeys } from "@/lib/date-filter";
import { chosenDayLabel, guestsLabel, searchSummary, searchText, showCountLabel } from "@/lib/search-text";
import { ExperienceSearchCalendar } from "./ExperienceSearchCalendar";
import { HandIcon } from "./HandIcon";
import { localeHref, useSiteCopy } from "./SiteLocale";

/*
 * The search bar of the home and the list (#698), one component for both languages (#658): 「キーワード｜日にち｜人数｜さがす」 in one
 * pill; below the sm breakpoint one button that opens a bottom sheet (a native <dialog>). It is a real GET form to the list
 * (q, date, guests, and the category when the list has one), so without scripts "Search" still reaches the list.
 *   navigate (home): the choices stay here; 「さがす」 opens the list with them.
 *   filter (list): the day and the party are the list's own state and apply when chosen; the keyword applies on submit.
 * Anything that changes at a breakpoint is a max-sm:/sm: pair: the presentation package's scoped CSS beats this app's
 * utilities when both set the same property (see ExperienceList's old finder), so a base class and a breakpoint class must not both be needed.
 */

export type SearchBarCard = { readonly slug: string; readonly offers: readonly CardOffer[] };

type Panel = "date" | "guests";

/** The mock API's theme filter (1.2): a select that applies when chosen, keeping the keyword. */
export type SearchThemeFilter = { label: string; any: string; selected: string; options: readonly { value: string; label: string }[] };

const SEGMENT = "flex min-h-[54px] w-full min-w-0 items-center gap-2 rounded-full px-4 py-1.5 text-left hover:bg-sand";
const SMALL = "block text-xs leading-[1.3] font-extrabold text-ink";
const VALUE = "block truncate text-[0.9375rem] leading-[1.4]";
const CLEAR = "absolute top-1/2 right-2 grid size-6 -translate-y-1/2 place-items-center rounded-full bg-moss text-sm leading-none font-extrabold text-white";
const POPOVER = "absolute top-[calc(100%+14px)] z-40 rounded-3xl border border-line bg-white p-[18px] shadow-[0_18px_50px_rgb(0_0_0/0.15)]";
const STEP_BUTTON = "grid size-[42px] place-items-center rounded-full border border-line-strong bg-white text-xl leading-none hover:bg-sand disabled:cursor-default disabled:opacity-35";
const GO = "inline-flex items-center justify-center gap-2 rounded-full bg-leaf font-extrabold text-ink hover:bg-leaf-hover";

function Stepper({ locale, guests, onChange }: { locale: "en" | "ja"; guests: number | null; onChange: (guests: number | null) => void }) {
  const words = searchText(locale);
  return <div className="min-w-[17rem] max-sm:min-w-0">
    <div className="flex items-center justify-between gap-4">
      <button type="button" className={STEP_BUTTON} aria-label={words.fewer} disabled={guests === null || guests <= 1} onClick={() => onChange(guests === null ? null : guests - 1)}>−</button>
      <b className="flex-1 text-center text-[1.0625rem]" aria-live="polite">{guests === null ? words.anyGuests : guestsLabel(guests, locale)}</b>
      <button type="button" className={STEP_BUTTON} aria-label={words.more} disabled={guests !== null && guests >= MAX_GUESTS} onClick={() => onChange(guests === null ? 2 : guests + 1)}>＋</button>
    </div>
    <div className="mt-3 text-right">
      <button type="button" className="text-[0.8125rem] font-extrabold text-moss underline underline-offset-[3px] disabled:opacity-40" disabled={guests === null} onClick={() => onChange(null)}>{words.anyGuests}</button>
    </div>
  </div>;
}

export function ExperienceSearchBar({
  locale, mode, placement = "list", initialQuery = "", category = null, date: dateProp = null, guests: guestsProp = null,
  onDateChange, onGuestsChange, windowStart, windowEnd, cards = [], availability = null, onNeedAvailability, resultCount, themeFilter,
}: {
  locale: "en" | "ja";
  mode: "navigate" | "filter";
  /** "hero" overlaps the bottom of the home's hero photo; "list" sits in the list's sticky row. */
  placement?: "hero" | "list";
  initialQuery?: string;
  category?: string | null;
  /** The chosen day and party. In `filter` mode they belong to the list, which answers `onDateChange` / `onGuestsChange`. */
  date?: string | null;
  guests?: number | null;
  onDateChange?: (date: string | null) => void;
  onGuestsChange?: (guests: number | null) => void;
  /** The days the calendar offers (JST, `YYYY-MM-DD`, inclusive). */
  windowStart: string;
  windowEnd: string;
  /** The cards and what was read for them: the calendar marks days with something on. Null availability = unknown, no day is marked or closed. */
  cards?: readonly SearchBarCard[];
  availability?: ReadonlyMap<string, readonly Occurrence[]> | null;
  /** Called when the day picker (or the phone sheet) is first opened, for a page that reads availability only then. */
  onNeedAvailability?: () => void;
  /** List mode: how many experiences the current choice shows, for the phone sheet's button. */
  resultCount?: number;
  themeFilter?: SearchThemeFilter;
}) {
  const router = useRouter();
  const copy = useSiteCopy();
  const words = searchText(locale);
  const ids = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const pillRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState(initialQuery);
  const [localDate, setLocalDate] = useState<string | null>(dateProp);
  const [localGuests, setLocalGuests] = useState<number | null>(guestsProp);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [sheet, setSheet] = useState(false);
  const date = mode === "filter" ? dateProp : localDate;
  const guests = mode === "filter" ? guestsProp : localGuests;

  const dayKeys = useMemo(() => windowDayKeys(windowStart, windowEnd), [windowStart, windowEnd]);
  const available = useMemo(() => availableDays(cards, availability, dayKeys, guests), [cards, availability, dayKeys, guests]);

  const chooseDate = (next: string | null) => { if (mode === "filter") onDateChange?.(next); else setLocalDate(next); };
  const chooseGuests = (next: number | null) => { if (mode === "filter") onGuestsChange?.(next); else setLocalGuests(next); };

  function closePanel(returnFocus = true) {
    const was = panel;
    setPanel(null);
    if (returnFocus && was) document.getElementById(`${ids}-trigger-${was}`)?.focus();
  }
  function openPanel(next: Panel) {
    if (panel === next) { closePanel(); return; }
    if (next === "date") onNeedAvailability?.();
    setPanel(next);
  }

  // Escape and a press outside the pill close a popover; focus goes back to its trigger.
  useEffect(() => {
    if (!panel) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); closePanel(); } };
    const onPress = (event: PointerEvent) => { if (!pillRef.current?.contains(event.target as Node)) closePanel(); };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPress);
    return () => { document.removeEventListener("keydown", onKey); document.removeEventListener("pointerdown", onPress); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel]);

  function openSheet() {
    onNeedAvailability?.();
    setPanel(null);
    setSheet(true);
  }
  // The sheet's content is mounted first, so the modal's focus lands on a real control.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (sheet && dialog && !dialog.open) dialog.showModal();
  }, [sheet]);
  function closeSheet() {
    const dialog = dialogRef.current;
    if (dialog?.open) dialog.close();
    setSheet(false);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const params = new URLSearchParams();
    const keyword = query.trim();
    if (keyword) params.set("q", keyword);
    if (date) params.set("date", date);
    if (guests !== null) params.set("guests", String(guests));
    if (category) params.set("category", category);
    const theme = new FormData(event.currentTarget).get("theme");
    if (typeof theme === "string" && theme) params.set("theme", theme);
    const text = params.toString();
    const target = localeHref("/experiences", locale);
    closeSheet();
    router.push(text ? `${target}?${text}` : target);
  }
  function clearAll() {
    setQuery("");
    chooseDate(null);
    chooseGuests(null);
  }

  const dateValue = date ? chosenDayLabel(date, locale) : words.anyDay;
  const guestsValue = guests === null ? words.anyGuests : guestsLabel(guests, locale);
  const placeholder = copy.text("catalogue.searchPlaceholder");
  const summarySet = date !== null || guests !== null;
  const place = placement === "hero"
    ? "z-[3] max-lg:relative max-lg:mx-4 max-lg:-mt-9 lg:absolute lg:bottom-[-38px] lg:left-1/2 lg:w-[min(860px,calc(100%_-_80px))] lg:-translate-x-1/2"
    : "relative";

  const segment = (name: Panel, icon: "cal" | "people", label: string, value: string, isSet: boolean, clear: () => void, content: ReactNode, align: "left" | "right") => (
    <div className="relative min-w-0 flex-1">
      <button
        type="button"
        id={`${ids}-trigger-${name}`}
        className={`${SEGMENT} ${panel === name ? "bg-leaf-pale" : ""} ${isSet ? "pr-10" : ""}`}
        aria-expanded={panel === name}
        aria-controls={`${ids}-${name}`}
        aria-haspopup="dialog"
        onClick={() => openPanel(name)}
      >
        <HandIcon name={icon} className="size-6 shrink-0" />
        <span className="min-w-0 flex-1">
          <small className={SMALL}>{label}</small>
          <b className={`${VALUE} ${isSet ? "font-extrabold text-moss" : "font-semibold text-muted"}`}>{value}</b>
        </span>
      </button>
      {isSet ? <button type="button" className={CLEAR} aria-label={`${words.clear}: ${label}`} onClick={() => { clear(); }}><span aria-hidden="true">×</span></button> : null}
      {panel === name ? <div id={`${ids}-${name}`} role="dialog" aria-label={name === "date" ? words.chooseDay : words.chooseGuests} className={`${POPOVER} ${align === "right" ? "right-0" : "left-0"}`}>{content}</div> : null}
    </div>
  );

  const calendar = (onPick: (next: string | null) => void) => (
    <ExperienceSearchCalendar locale={locale} start={windowStart} end={windowEnd} value={date} available={available} onChange={onPick} />
  );

  return (
    <form ref={formRef} action={localeHref("/experiences", locale)} method="get" role="search" aria-label={words.find} onSubmit={submit} className={place}>
      {/* The pill (sm and wider). */}
      <div ref={pillRef} className={`relative max-w-[880px] items-center rounded-full border border-line-strong bg-white py-1.5 pr-1.5 pl-2 ${placement === "hero" ? "shadow-[0_10px_30px_rgb(0_0_0/0.12),0_1px_2px_rgb(0_0_0/0.06)]" : "shadow-[0_6px_22px_rgb(0_0_0/0.07)]"} max-sm:hidden sm:flex`}>
        <label className={`${SEGMENT} flex-[1.35] cursor-text hover:bg-transparent focus-within:bg-sand`}>
          <HandIcon name="search" className="size-6 shrink-0" />
          <span className="min-w-0 flex-1">
            <small className={SMALL}>{words.what}</small>
            <input name="q" type="search" maxLength={80} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={placeholder} aria-label={`${words.what}: ${copy.text("catalogue.searchLabel")}`} className="block w-full truncate border-0 bg-transparent p-0 text-[0.9375rem] leading-[1.4] outline-none placeholder:text-muted" />
          </span>
        </label>
        <span aria-hidden="true" className="h-[30px] w-px shrink-0 bg-line" />
        {segment("date", "cal", words.when, dateValue, date !== null, () => chooseDate(null), calendar((next) => { chooseDate(next); closePanel(); }), "left")}
        <span aria-hidden="true" className="h-[30px] w-px shrink-0 bg-line" />
        {segment("guests", "people", words.guests, guestsValue, guests !== null, () => chooseGuests(null), <Stepper locale={locale} guests={guests} onChange={chooseGuests} />, "right")}
        <button type="submit" className={`${GO} ml-1 min-h-[52px] shrink-0 px-6 text-base`}>
          <HandIcon name="search" className="size-5" />{words.search}
        </button>
      </div>

      {/* Phones: one pill; without scripts it still submits the form. */}
      <button
        type="submit"
        aria-haspopup="dialog"
        onClick={(event) => { event.preventDefault(); openSheet(); }}
        className="w-full items-center gap-3 rounded-full border border-line-strong bg-white py-2 pr-2 pl-[18px] text-left shadow-[0_6px_22px_rgb(0_0_0/0.07)] max-sm:flex sm:hidden"
      >
        <span className="min-w-0 flex-1">
          <b className="block text-[0.9375rem] leading-[1.35] font-extrabold">{words.find}</b>
          <small className={`block truncate text-[0.8125rem] ${summarySet ? "font-extrabold text-moss" : "text-muted"}`}>{searchSummary(date, guests, locale)}</small>
        </span>
        <span className="grid size-[46px] shrink-0 place-items-center rounded-full bg-leaf"><HandIcon name="search" className="size-6" /></span>
      </button>

      {themeFilter ? <label className="mt-2 flex items-center gap-2 text-sm font-extrabold">
        {themeFilter.label}
        <select name="theme" defaultValue={themeFilter.selected} onChange={() => formRef.current?.requestSubmit()} className="min-h-10 rounded-xl border border-line-strong bg-white px-3 text-base font-normal">
          <option value="">{themeFilter.any}</option>
          {themeFilter.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </label> : null}

      {date ? <input type="hidden" name="date" value={date} /> : null}
      {guests !== null ? <input type="hidden" name="guests" value={guests} /> : null}
      {category ? <input type="hidden" name="category" value={category} /> : null}

      <dialog
        ref={dialogRef}
        aria-labelledby={`${ids}-sheet`}
        onClose={() => setSheet(false)}
        className="m-0 mt-auto max-h-[90dvh] w-full max-w-full overflow-y-auto rounded-t-[26px] border-0 bg-white p-0 text-ink backdrop:bg-black/35"
      >
        {sheet ? <div className="px-5 pt-1.5">
          <div className="sticky top-0 z-[1] flex items-center justify-between bg-white py-3">
            <b id={`${ids}-sheet`} className="text-[1.0625rem]">{words.sheetTitle}</b>
            <button type="button" className="grid size-[38px] place-items-center rounded-full border border-line-strong bg-white text-lg" aria-label={words.close} onClick={closeSheet}><span aria-hidden="true">×</span></button>
          </div>
          <div className="border-t border-line py-3.5">
            <label className="flex min-h-[50px] items-center gap-2.5 rounded-[14px] border border-line-strong px-3.5">
              <HandIcon name="search" className="size-6 shrink-0" />
              <span className="sr-only">{copy.text("catalogue.searchLabel")}</span>
              <input type="search" maxLength={80} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={placeholder} className="min-w-0 flex-1 border-0 bg-transparent text-base outline-none placeholder:text-muted" />
            </label>
          </div>
          <div className="border-t border-line py-3.5">
            <p className="mb-2.5 text-sm font-extrabold">{words.when}</p>
            {calendar(chooseDate)}
          </div>
          <div className="border-t border-line py-3.5">
            <p className="mb-2.5 text-sm font-extrabold">{words.guests}</p>
            <Stepper locale={locale} guests={guests} onChange={chooseGuests} />
          </div>
          <div className="sticky bottom-0 flex items-center justify-between gap-3 border-t border-line bg-white pt-3 pb-[max(1.125rem,env(safe-area-inset-bottom))]">
            <button type="button" className="text-[0.9375rem] font-extrabold text-moss underline underline-offset-[3px]" onClick={clearAll}>{words.clearAll}</button>
            {mode === "filter"
              ? <button type="button" className={`${GO} min-h-12 px-6`} onClick={() => { if (query.trim() !== initialQuery) formRef.current?.requestSubmit(); else closeSheet(); }}>{showCountLabel(resultCount ?? 0, locale)}</button>
              : <button type="submit" className={`${GO} min-h-12 px-6`}>{words.search}</button>}
          </div>
        </div> : null}
      </dialog>
    </form>
  );
}
