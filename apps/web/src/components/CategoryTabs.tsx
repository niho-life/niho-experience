import Link from "next/link";
import { ALL_CATEGORIES_LABEL, CATEGORIES_NAV_LABEL, categoryLabel, type SiteLocale } from "@/lib/experience-categories";
import type { ExperienceCategoryId } from "@niho-experience/experience-domain";
import { CategoryIcon } from "./CategoryIcon";

/** The conditions the category row keeps when it changes the category. */
export type CategoryTabsQuery = Readonly<{ date?: string | null; guests?: number | null; q?: string | null }>;

/** The list's address for a category (or none), keeping the day, the party size and the search. Plain query parameters, so it works without scripts. */
export function categoryHref(locale: SiteLocale, category: ExperienceCategoryId | null, query: CategoryTabsQuery = {}): string {
  const params = new URLSearchParams();
  if (category) params.set("category", category);
  if (query.date) params.set("date", query.date);
  if (query.guests != null) params.set("guests", String(query.guests));
  if (query.q) params.set("q", query.q);
  const base = locale === "ja" ? "/ja/experiences" : "/experiences";
  const text = params.toString();
  return text ? `${base}?${text}` : base;
}

/** 「すべて」's icon: four tiles, drawn like the others (a line of the current colour). */
function AllIcon({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z" />
    </svg>
  );
}

/**
 * The category row of the home and the list (#658, #698), one component for both languages: a hand-drawn line icon above the
 * label, 「All／すべて」 first, then the categories that have an experience (the chosen one is always shown). Plain links, so every
 * state has an address and it works without scripts. Nothing is drawn when there is no category to offer.
 *   list: tabs under the search bar; the chosen one is moss text, a moss bottom border and a pale-green icon tile. A row you can scroll on a phone.
 *   home: a centred row under the hero; no chosen state. Phone-only values are max-sm: because package-scoped base classes would beat sm: ones.
 */
export function CategoryTabs({ locale, categories, selected = null, query = {}, variant }: {
  locale: SiteLocale;
  categories: readonly ExperienceCategoryId[];
  selected?: ExperienceCategoryId | null;
  query?: CategoryTabsQuery;
  variant: "home" | "list";
}) {
  if (categories.length === 0) return null;
  const list = variant === "list";
  const tab = (id: ExperienceCategoryId | null) => {
    const chosen = list && selected === id;
    const label = id ? categoryLabel(id, locale) : ALL_CATEGORIES_LABEL[locale];
    return (
      <Link
        key={id ?? "all"}
        href={categoryHref(locale, id, list ? query : {})}
        aria-current={chosen ? "page" : undefined}
        className={`group flex min-w-[76px] shrink-0 flex-col items-center gap-1 px-2 text-[0.8125rem] whitespace-nowrap sm:min-w-[84px] sm:px-3 ${list ? `-mb-px border-b-[3px] pt-1 pb-2.5 ${chosen ? "border-moss font-extrabold text-moss" : "border-transparent font-bold text-ink-soft"}` : "py-1 font-bold text-ink-soft hover:text-ink"}`}
      >
        <span className={`grid size-[46px] place-items-center rounded-[15px] ${chosen ? "bg-leaf-pale" : "group-hover:bg-sand"}`}>
          {id ? <CategoryIcon id={id} className="size-7" /> : <AllIcon className="size-7" />}
        </span>
        {label}
      </Link>
    );
  };
  return (
    <div className={list ? "container-page mt-3" : "container-page max-lg:pt-6 lg:pt-[72px]"}>
      <nav aria-label={CATEGORIES_NAV_LABEL[locale]} className={`scrollbar-none flex gap-1 overflow-x-auto max-sm:-mx-5 max-sm:px-3 ${list ? "border-b border-line" : "sm:justify-center sm:gap-3"}`}>
        {tab(null)}
        {categories.map((id) => tab(id))}
      </nav>
    </div>
  );
}
