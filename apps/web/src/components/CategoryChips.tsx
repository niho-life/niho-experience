import Link from "next/link";
import { ALL_CATEGORIES_LABEL, CATEGORIES_NAV_LABEL, categoryLabel, type SiteLocale } from "@/lib/experience-categories";
import type { ExperienceCategoryId } from "@niho-experience/experience-domain";
import { CategoryIcon } from "./CategoryIcon";

/** The conditions the category row keeps when it changes the category. */
export type CategoryChipsQuery = Readonly<{ date?: string | null; guests?: number | null; q?: string | null }>;

/** The list's address for a category (or none), keeping the day, the party size and the search. Plain query parameters, so it works without scripts. */
export function categoryHref(locale: SiteLocale, category: ExperienceCategoryId | null, query: CategoryChipsQuery = {}): string {
  const params = new URLSearchParams();
  if (category) params.set("category", category);
  if (query.date) params.set("date", query.date);
  if (query.guests != null) params.set("guests", String(query.guests));
  if (query.q) params.set("q", query.q);
  const base = locale === "ja" ? "/ja/experiences" : "/experiences";
  const text = params.toString();
  return text ? `${base}?${text}` : base;
}

const CHIP = "inline-flex min-h-10 shrink-0 items-center gap-1.5 rounded-full border px-4 text-sm font-extrabold whitespace-nowrap";
const ON = "border-ink bg-ink text-white";
const OFF = "border-line-strong bg-white hover:bg-sand";

/**
 * The category row of the list, one component for both languages (#658): 「All／すべて」 and the categories that have an
 * experience on this list (the chosen one is always shown). Plain links, so every state has an address and it works without
 * scripts. Nothing is drawn when there is no category to offer. A row you can scroll on a phone; it wraps on a wide screen.
 */
export function CategoryChips({ locale, categories, selected, query = {} }: { locale: SiteLocale; categories: readonly ExperienceCategoryId[]; selected: ExperienceCategoryId | null; query?: CategoryChipsQuery }) {
  if (categories.length === 0) return null;
  return (
    <div className="container-page mt-5">
      <nav aria-label={CATEGORIES_NAV_LABEL[locale]} className="-mx-5 flex gap-2 overflow-x-auto px-5 pb-1 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 [&::-webkit-scrollbar]:hidden">
        <Link href={categoryHref(locale, null, query)} aria-current={selected === null ? "page" : undefined} className={`${CHIP} ${selected === null ? ON : OFF}`}>{ALL_CATEGORIES_LABEL[locale]}</Link>
        {categories.map((id) => (
          <Link key={id} href={categoryHref(locale, id, query)} aria-current={selected === id ? "page" : undefined} className={`${CHIP} ${selected === id ? ON : OFF}`}>
            <CategoryIcon id={id} className="size-4" />{categoryLabel(id, locale)}
          </Link>
        ))}
      </nav>
    </div>
  );
}
