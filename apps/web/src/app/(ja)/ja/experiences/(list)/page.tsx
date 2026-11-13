import type { Metadata } from "next";
import { JaExperienceList } from "@/components/ja/JaExperienceList";
import { cardsBookableOn, loadJaCards } from "@/lib/ja-catalog-server";
import { filterJaCards, jaCategoryCounts, jaCategoryOf, jaListHref, jaQueryHasFilter, parseJaListQuery, type JaCard } from "@/lib/ja-catalog";
import { CatalogueViewV1 } from "@niho/experience-presentation/v1";
import { ExperienceList } from "@/components/ExperienceList";
import { ExperienceFiltersForm } from "@/components/ExperienceFiltersForm";
import { EmptyResults } from "@/components/States";
import { JapaneseUnavailable } from "@/components/JapaneseUnavailable";
import { getApi } from "@/lib/api";
import { config } from "@/lib/config";
import { buildCardModels } from "@/lib/card-model";
import { loadDetails } from "@/lib/catalog";
import { guestBookingSources } from "@/lib/guest-booking-source";
import { dayOption, parseDateParam, parseGuestsParam, upcomingDays } from "@/lib/date-filter";
import { filterExperienceSummaries, normalizeExperienceQuery, type SearchParams } from "@/lib/filters";
import { assertSameJapaneseRelease, getJapaneseCatalog, getJapaneseCopy } from "@/lib/localized-content";
import { japaneseStaticMetadata } from "@/lib/locale-metadata";
import type { ExperienceSummaryForSite } from "@/lib/experience-types";
import { getReviewSummaries } from "@/lib/journey";
import { withReviewLines } from "@/lib/reviews-ui";

/**
 * 日本語の一覧の検索公開の方針 (#529, docs/product-classification.md): the list and a category's list are for search engines,
 * a category only while it has a published experience; any other condition (area, だれと, こんな日に, 人数, 日にち) is not
 * (`noindex, follow`) and points to the list it narrows, so thin lists are never generated without limit.
 */
async function httpMetadata(params: SearchParams): Promise<Metadata> {
  const days = upcomingDays(new Date(), JA_CHIP_DAYS, "ja");
  const query = parseJaListQuery(params, days);
  const cards = await loadJaCards();
  const category = jaCategoryOf(query.category);
  const count = query.category ? jaCategoryCounts(cards).get(query.category) ?? 0 : cards.length;
  const canonicalPath = jaListHref({ category: query.category, area: null, companion: null, occasion: null, guests: null, date: null });
  const indexable = !jaQueryHasFilter(query) && count > 0 && !normalizeExperienceQuery(params.q);
  return {
    title: category ? `${category.label}の体験` : "鎌倉の体験",
    description: category ? category.lead : "鎌倉・逗子・葉山の人と活動に、会いにいく。体験を探せます。",
    alternates: { canonical: `${config.siteUrl}${canonicalPath}`, ...(query.category ? {} : { languages: { en: `${config.siteUrl}/experiences`, ja: `${config.siteUrl}/ja/experiences`, "x-default": `${config.siteUrl}/experiences` } }) },
    robots: indexable ? undefined : { index: false, follow: true },
  };
}

const JA_CHIP_DAYS = 10;

export async function generateMetadata({ searchParams }: { searchParams: Promise<SearchParams> }): Promise<Metadata> {
  try {
    const query = await searchParams;
    if (config.apiMode === "http") return await httpMetadata(query);
    const filtered = query.date !== undefined || query.guests !== undefined || normalizeExperienceQuery(query.q) !== "";
    return await japaneseStaticMetadata("experiences", filtered);
  } catch { return { title: "Japanese experiences unavailable", robots: { index: false, follow: false } }; }
}

const CHIP_DAYS = 7;
const FINDER_DAYS = 14;

export default async function JapaneseExperiencesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const query = await searchParams;
  if (config.apiMode === "http") {
    // 日本語サイト独自の一覧 (#529): categories, days, area / だれと / こんな日に / 人数, and the cards. Not a translation of the English list.
    const days = upcomingDays(new Date(), JA_CHIP_DAYS, "ja");
    const parsed = parseJaListQuery(query, days);
    let result: { cards: readonly JaCard[]; total: number } | null = null;
    try {
      const all = await loadJaCards();
      const matched = filterJaCards(all, parsed);
      result = { cards: parsed.date ? await cardsBookableOn(matched, parsed.date, parsed.guests) : matched, total: all.length };
    } catch { result = null; }
    return result ? <JaExperienceList cards={result.cards} query={parsed} days={days} total={result.total} /> : <JapaneseUnavailable />;
  }
  let data;
  try {
    const [copy, api] = await Promise.all([getJapaneseCopy(), getApi()]);
    // Mock mode only (the live site is above): the static Japanese release.
    const selected = await getJapaneseCatalog();
    assertSameJapaneseRelease(copy.releaseId, selected);
    const catalog: ExperienceSummaryForSite[] = selected.experiences;
    const searchQuery = normalizeExperienceQuery(query.q);
    const items = filterExperienceSummaries(catalog, searchQuery);
    const plainCards = buildCardModels(items, await loadDetails(api, items, true, "ja", copy.releaseId), false, "ja", copy.copy);
    const cards = withReviewLines(plainCards, await getReviewSummaries(plainCards.map((card) => card.slug)), "ja");
    const now = new Date(), finderDays = upcomingDays(now, FINDER_DAYS, "ja");
    const initialDate = parseDateParam(query.date, finderDays);
    const initialGuests = parseGuestsParam(query.guests);
    const days = upcomingDays(now, CHIP_DAYS, "ja");
    if (initialDate && !days.some((day) => day.key === initialDate)) days.push(dayOption(initialDate, "ja"));
    data = { copy, cards, searchQuery, initialDate, initialGuests, days };
  } catch { return <JapaneseUnavailable />; }
  const { copy, cards, searchQuery, initialDate, initialGuests, days } = data;
  // Where each card's availability is read: NIHO, or this site for an experience sold here (#285).
  const bookingSources = await guestBookingSources(cards.map((card) => card.slug));
  const searchProps = { searchQuery, theme: undefined, date: initialDate ?? undefined, guests: initialGuests, filtersEnabled: false, filtersActive: Boolean(searchQuery || initialDate || initialGuests !== null) };
  return <CatalogueViewV1 copy={copy.copy} heading={copy.copy.text("catalogue.title")} intro="鎌倉の少人数制の体験を探せます。料金は日本円、時刻は日本時間（JST）です。" content={<ExperienceList
      key={JSON.stringify([searchQuery, initialDate, initialGuests])} cards={cards} days={days} initialDate={initialDate} initialGuests={initialGuests} browseContext={{ q: searchQuery || undefined }} catalogDateFiltered={false} preview={false} bookingSources={bookingSources}
      search={<ExperienceFiltersForm key="bar-search" {...searchProps} placement="bar" />} inlineSearch={<ExperienceFiltersForm key="inline-search" {...searchProps} placement="inline" />} columns="three"
      empty={<EmptyResults key="empty-results" clearHref={searchQuery || initialDate || initialGuests !== null ? "/experiences" : null} searchActive={Boolean(searchQuery)} />}
    />} />;
}
