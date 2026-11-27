import type { Metadata } from "next";
import type { StaticCopyAccessorV1 } from "@niho/experience-presentation/v1";
import { JaListConsult, JaListEmpty } from "@/components/ja/JaListConsult";
import { ExperiencesPageView } from "@/components/pages/ExperiencesPageView";
import { EmptyResults, StagingUnavailableState } from "@/components/States";
import { JapaneseUnavailable } from "@/components/JapaneseUnavailable";
import { config, isExperienceStaging } from "@/lib/config";
import type { CardModel } from "@/lib/card-model";
import { parseDateParam, parseGuestsParam, SEARCH_DAYS, upcomingDays } from "@/lib/date-filter";
import { categoryLabel, categoryLeadJa, filterByCategory, parseCategoryParam, resolveCategories } from "@/lib/experience-categories";
import { japaneseListPublication } from "@/lib/experience-list-catalog";
import { loadCategoryBySlug } from "@/lib/experience-categories-server";
import { sitePublicationCard } from "@/lib/experience/site-card-model";
import { listSitePublicExperiences } from "@/lib/experience/site-publications";
import { normalizeExperienceQuery, type SearchParams } from "@/lib/filters";
import { groupInquiryOpen } from "@/lib/group-inquiry-links";
import { guestBookingSources } from "@/lib/guest-booking-source";
import { getReviewSummaries } from "@/lib/journey";
import { filterCardsByText } from "@/lib/list-text";
import { getJapaneseCopy } from "@/lib/localized-content";
import { withReviewLines } from "@/lib/reviews-ui";

/**
 * 日本語の一覧の検索公開の方針 (#529, docs/product-classification.md): the list and a category's list are for search engines,
 * a category only while it has a published experience; any other condition (人数, 日にち, 検索) is not (`noindex, follow`) and
 * points to the list it narrows, so thin lists are never generated without limit.
 */
export async function generateMetadata({ searchParams }: { searchParams: Promise<SearchParams> }): Promise<Metadata> {
  try {
    const query = await searchParams;
    const requested = parseCategoryParam(query.category);
    const [catalog, bySlug] = await Promise.all([listSitePublicExperiences("ja"), loadCategoryBySlug()]);
    const slugs = catalog.experiences.filter(japaneseListPublication).map(({ publication }) => publication.slug);
    const category = bySlug ? requested : null;
    const count = category ? slugs.filter((slug) => bySlug?.get(slug) === category).length : slugs.length;
    const hasFilter = query.date !== undefined || query.guests !== undefined || normalizeExperienceQuery(query.q) !== "";
    const canonicalPath = category ? `/ja/experiences?category=${category}` : "/ja/experiences";
    return {
      title: category ? `${categoryLabel(category, "ja")}の体験` : "鎌倉の体験",
      description: category ? categoryLeadJa(category) : "鎌倉・逗子・葉山の人と活動に、会いにいく。体験を探せます。",
      alternates: { canonical: `${config.siteUrl}${canonicalPath}`, ...(category ? {} : { languages: { en: `${config.siteUrl}/experiences`, ja: `${config.siteUrl}/ja/experiences`, "x-default": `${config.siteUrl}/experiences` } }) },
      // This value replaces the layout's robots, so the "search publishing is off" case (previews, staging) is said here too.
      robots: !config.indexingAllowed ? { index: false, follow: false } : !hasFilter && count > 0 ? undefined : { index: false, follow: true },
    };
  } catch { return { title: "Japanese experiences unavailable", robots: { index: false, follow: false } }; }
}

export default async function JapaneseExperiencesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const query = await searchParams;
  // 日本語サイトは http モードだけで開く（`config.japaneseSiteEnabled`、レイアウトが閉じる）。英語の一覧と同じ1つの部品が描く（#658）。
  let copy: StaticCopyAccessorV1;
  let allCards: CardModel[];
  try {
    copy = (await getJapaneseCopy()).copy;
    const catalog = await listSitePublicExperiences("ja");
    allCards = catalog.experiences.flatMap((item) => {
      const card = sitePublicationCard(item, "ja", { copy });
      return card ? [card] : [];
    });
  } catch { return isExperienceStaging ? <StagingUnavailableState /> : <JapaneseUnavailable />; }

  const searchQuery = normalizeExperienceQuery(query.q);
  const bySlug = await loadCategoryBySlug();
  const { available: categories, selected: category } = resolveCategories(allCards.map((card) => card.slug), bySlug, parseCategoryParam(query.category));
  const plainCards = filterByCategory(filterCardsByText(allCards, searchQuery), bySlug, category);
  const cards = withReviewLines(plainCards, await getReviewSummaries(plainCards.map((card) => card.slug)), "ja");
  const bookingSources = await guestBookingSources(cards.map((card) => card.slug));
  const now = new Date();
  const days = upcomingDays(now, SEARCH_DAYS, "ja");
  const initialDate = parseDateParam(query.date, days);
  const initialGuests = parseGuestsParam(query.guests);
  const inquiryOpen = groupInquiryOpen();
  const filtersActive = Boolean(searchQuery || initialDate || initialGuests !== null || category);
  return <ExperiencesPageView
    locale="ja" copy={copy} cards={cards} days={days} initialDate={initialDate} initialGuests={initialGuests}
    searchQuery={searchQuery} category={category} categories={categories} bookingSources={bookingSources}
    empty={inquiryOpen ? <JaListEmpty total={allCards.length} /> : <EmptyResults key="empty-results" clearHref={filtersActive ? "/ja/experiences" : null} searchActive={Boolean(searchQuery)} />}
    consult={inquiryOpen ? <JaListConsult /> : undefined}
  />;
}
