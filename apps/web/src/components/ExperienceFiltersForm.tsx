"use client";

import { useRouter } from "next/navigation";
import type { FormEvent } from "react";
import type { ExperienceSiteTheme } from "@niho-experience/api-client";
import { EXPERIENCE_SITE_THEMES, EXPERIENCE_THEME_LABELS } from "@/lib/filters";
import { HandIcon } from "./HandIcon";
import { buttonClass } from "./ui";
import { LocalizedLink } from "./LocalizedLink";
import { localeHref, useSiteCopy, useSiteLocale } from "./SiteLocale";

/**
 * Search (and, from API 1.2, the theme filter) behind a small round magnifier button.
 * A native <details> with a GET form, so it opens and submits without JavaScript. It starts
 * open whenever a search word or theme is in the URL, so the guest sees what is applied.
 * `placement="bar"`: the button sits at the end of the date-chip row and the form opens below it.
 */
export function ExperienceFiltersForm({
  searchQuery,
  theme,
  date,
  guests,
  category,
  filtersEnabled,
  filtersActive,
  placement = "bar",
}: {
  searchQuery: string;
  theme: ExperienceSiteTheme | undefined;
  date: string | undefined;
  guests?: number | null;
  /** The chosen category (#658): a search keeps it. */
  category?: string | null;
  filtersEnabled: boolean;
  filtersActive: boolean;
  placement?: "bar" | "inline";
}) {
  const router = useRouter();
  const copy = useSiteCopy();
  const { locale } = useSiteLocale();

  function submitWithClientNavigation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const params = new URLSearchParams();
    for (const [name, value] of new FormData(event.currentTarget)) {
      if (typeof value === "string") params.append(name, value);
    }
    const query = params.toString();
    const target = localeHref("/experiences", locale);
    router.push(query ? `${target}?${query}` : target);
  }

  const field = "min-h-12 w-full rounded-xl border border-line-strong bg-surface px-3 text-base font-normal";
  return (
    <details open={Boolean(searchQuery || theme)} className="group" data-search>
      <summary
        className={`grid size-12 cursor-pointer list-none place-items-center rounded-full border border-line-strong bg-white hover:bg-sand group-open:border-ink group-open:bg-leaf-pale [&::-webkit-details-marker]:hidden ${
          placement === "bar" ? "absolute top-2.5 right-0 shadow-[-10px_0_10px_rgb(255_255_255)]" : ""
        }`}
      >
        <HandIcon name="search" className="size-6" />
        <span className="sr-only">{copy.text("catalogue.search")}</span>
      </summary>
      <form role="search" action={localeHref("/experiences", locale)} method="get" onSubmit={submitWithClientNavigation} className="mt-3 space-y-3 rounded-[18px] border border-line bg-white p-3">
        <label htmlFor="experience-search" className="sr-only">
          {copy.text("catalogue.searchLabel")}
        </label>
        <div className="flex gap-2">
          <input id="experience-search" name="q" type="search" maxLength={80} defaultValue={searchQuery} placeholder={copy.text("catalogue.searchPlaceholder")} className={`${field} min-w-0 flex-1`} />
          {filtersEnabled ? null : (
            <button type="submit" className={buttonClass("primary", "min-h-12 shrink-0 px-5")}>
              {copy.text("catalogue.search")}
            </button>
          )}
        </div>
        {filtersEnabled ? (
          <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
            <label htmlFor="experience-theme" className="block text-sm font-extrabold">
              {copy.text("catalogue.theme")}
              <select id="experience-theme" name="theme" defaultValue={theme ?? ""} className={`${field} mt-1`}>
                <option value="">{copy.text("catalogue.anyTheme")}</option>
                {EXPERIENCE_SITE_THEMES.map((value) => (
                  <option key={value} value={value}>
                    {EXPERIENCE_THEME_LABELS[value]}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" className={buttonClass("primary", "min-h-12")}>
              {copy.text("catalogue.applyFilters")}
            </button>
          </div>
        ) : null}
        {date ? <input type="hidden" name="date" value={date} /> : null}
        {guests != null ? <input type="hidden" name="guests" value={guests} /> : null}
        {category ? <input type="hidden" name="category" value={category} /> : null}
        {filtersEnabled && filtersActive ? (
          <div>
            <LocalizedLink href="/experiences" className="text-sm font-bold text-moss underline">
              {copy.text("catalogue.clearFilters")}
            </LocalizedLink>
          </div>
        ) : null}
      </form>
    </details>
  );
}
