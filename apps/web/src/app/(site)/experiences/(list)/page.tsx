import type { Metadata } from "next";
import Link from "next/link";
import { EN_STATIC_COPY_V1 } from "@niho/experience-presentation/v1";
import { TrackView } from "@/components/Analytics";
import { ExperiencesPageView } from "@/components/pages/ExperiencesPageView";
import { ErrorState, StagingUnavailableState } from "@/components/States";
import { GuideTeasers } from "@/components/GuideBlocks";
import { getApi, listExperiencesForSite } from "@/lib/api";
import { buildCardModels } from "@/lib/card-model";
import { loadDetails } from "@/lib/catalog";
import { getReviewSummaries } from "@/lib/journey";
import { withReviewLines } from "@/lib/reviews-ui";
import { config, isExperienceStaging, isPilotPreview, isPreview } from "@/lib/config";
import { dayOption, parseDateParam, parseGuestsParam, upcomingDays } from "@/lib/date-filter";
import { filterExperienceSummaries, matchesExperienceQuery, normalizeExperienceDate, normalizeExperienceQuery, normalizeExperienceTheme, type SearchParams } from "@/lib/filters";
import { EXPERIENCE_LIST_DESCRIPTION, EXPERIENCE_LIST_TITLE, publicMetadata } from "@/lib/public-metadata";
import { englishAlternates } from "@/lib/locale-metadata";
import { guideCatalogForSite } from "@/lib/guide-registry";
import { guestBookingSources } from "@/lib/guest-booking-source";
import { listSitePublicExperiences } from "@/lib/experience/site-publications";
import { providerNameFor } from "@/lib/experience/provider-name";
import { sitePublicationCard } from "@/lib/experience/site-card-model";
import { filterByCategory, parseCategoryParam, resolveCategories } from "@/lib/experience-categories";
import { loadCategoryBySlug } from "@/lib/experience-categories-server";
import { englishListCatalog } from "@/lib/experience-list-catalog";
import { withoutNativeSlugs } from "@/lib/experience/dedupe-slugs";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function generateMetadata({ searchParams }: { searchParams: Promise<SearchParams> }): Promise<Metadata> {
  const query = await searchParams;
  const filtered = query.theme !== undefined || query.category !== undefined || query.date !== undefined || query.guests !== undefined || normalizeExperienceQuery(query.q) !== "";
  return {
    ...publicMetadata(EXPERIENCE_LIST_TITLE, EXPERIENCE_LIST_DESCRIPTION, `${config.siteUrl}/experiences`), alternates: await englishAlternates("/experiences"),
    ...(filtered ? { robots: { index: false, follow: true } } : {}),
  };
}

/**
 * The native cards are searched by the same rule and the same fields as the legacy summaries (`filterExperienceSummaries`): every
 * word, in any order, over the title, the lead, the provider and the region. With the duplicates gone (#643) a product sold here
 * is found only through its native card, so a search that found it before must still find it.
 */
const NATIVE_REGION_NAME = "Kamakura";

/** The home finder and the list's date chips both cover two weeks; the chips show only days with something on. A later date in the URL gets its own chip. */
const FINDER_DAYS = 14;

export default async function ExperiencesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const query = await searchParams;
  const searchQuery = normalizeExperienceQuery(query.q);
  const siteCatalogPromise = listSitePublicExperiences("en").catch((error: unknown) => {
    if (!isExperienceStaging) throw error;
    console.error("[experiences] staging public catalog unavailable");
    return null;
  });
  const [api, result, guideCatalogResult, siteCatalog] = await Promise.all([getApi(query), listExperiencesForSite("kamakura", query), guideCatalogForSite(), siteCatalogPromise]);
  if (siteCatalog === null) return <StagingUnavailableState />;
  const copy = EN_STATIC_COPY_V1;
  // Native publications have no theme field yet; keep the unsupported filter out of the live form.
  const themesEnabled = config.apiMode === "mock" && config.publicApiVersion === "1.2";
  const theme = themesEnabled ? normalizeExperienceTheme(query.theme) : undefined;
  const { catalog, native, slugs } = englishListCatalog(result.ok ? result.data.experiences : [], siteCatalog);
  const items = filterExperienceSummaries(catalog, searchQuery);
  const legacyCards = buildCardModels(items, await loadDetails(api, items, config.publicApiVersion !== "1.0"), isPilotPreview);
  const nativeCards = native
    .filter(({ publication }) => !theme && matchesExperienceQuery(`${publication.slug} ${publication.publicTitle} ${publication.content.lead} ${publication.providerPublicNameEn ?? ""} ${providerNameFor(publication, "ja") ?? ""} ${publication.sellerDisplayName} ${NATIVE_REGION_NAME}`, searchQuery))
    .map((entry) => sitePublicationCard(entry));
  const bySlug = await loadCategoryBySlug();
  const { available: categories, selected: category } = resolveCategories(
    // Every experience on this list before the search narrows it, so the row does not change while searching.
    slugs,
    bySlug,
    parseCategoryParam(query.category),
  );
  const cardsWithoutReviews = filterByCategory([...withoutNativeSlugs(legacyCards, nativeCards.map((card) => card.slug)), ...nativeCards], bySlug, category);
  const cards = withReviewLines(cardsWithoutReviews, await getReviewSummaries(cardsWithoutReviews.map((card) => card.slug)));
  if (!result.ok && result.kind !== "not_found" && cards.length === 0) return <ErrorState title="We couldn't load experiences" />;

  // Where each card's availability is read: NIHO, or this site for an experience sold here (#285).
  const bookingSources = await guestBookingSources(cards.map((card) => card.slug));
  const now = new Date();
  const finderDays = upcomingDays(now, FINDER_DAYS);
  const catalogDate = config.publicApiVersion === "1.2" ? normalizeExperienceDate(query.date) : undefined;
  const initialDate = catalogDate ?? parseDateParam(query.date, finderDays);
  const date = config.publicApiVersion === "1.2" ? normalizeExperienceDate(query.date) : undefined;
  const initialGuests = parseGuestsParam(query.guests);
  const days = upcomingDays(now, FINDER_DAYS);
  if (initialDate && !days.some((day) => day.key === initialDate)) days.push(dayOption(initialDate));

  const readings = guideCatalogResult.guides.length ? (
    <section className="container-page pt-16 lg:pt-[88px]" aria-labelledby="catalogue-guides-heading">
      <div className="mb-5 flex items-end justify-between gap-4">
        <div><p className="eyebrow">plan your day</p><h2 id="catalogue-guides-heading" className="mt-1 text-[2rem] lg:text-[2.75rem]">From the Journal</h2></div>
        <Link href="/guides" className="link-leaf shrink-0 text-sm">See all</Link>
      </div>
      <GuideTeasers guides={guideCatalogResult.guides.slice(0, 3)} draftSlugs={guideCatalogResult.draftSlugs} columns="three" descriptions={false} />
    </section>
  ) : null;

  return <>
    <TrackView event="list_view" props={{ theme: theme ?? "all", date_filtered: initialDate !== null, result_count: cards.length }} />
    <ExperiencesPageView
      locale="en"
      copy={copy}
      cards={cards}
      days={days}
      initialDate={initialDate}
      initialGuests={initialGuests}
      searchQuery={searchQuery}
      category={category}
      categories={categories}
      theme={theme}
      themesEnabled={themesEnabled}
      catalogDateFiltered={config.apiMode === "mock" && config.publicApiVersion === "1.2" && Boolean(date)}
      preview={isPreview}
      bookingSources={bookingSources}
      readings={readings}
    />
  </>;
}
