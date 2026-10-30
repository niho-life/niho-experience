import type { Metadata } from "next";
import Link from "next/link";
import { CatalogueViewV1, EN_STATIC_COPY_V1 } from "@niho/experience-presentation/v1";
import { TrackView } from "@/components/Analytics";
import { ExperienceList } from "@/components/ExperienceList";
import { ExperienceFiltersForm } from "@/components/ExperienceFiltersForm";
import { EmptyResults, ErrorState } from "@/components/States";
import { GuideTeasers } from "@/components/GuideBlocks";
import { getApi, listExperiencesForSite } from "@/lib/api";
import { buildCardModels } from "@/lib/card-model";
import { loadDetails } from "@/lib/catalog";
import { getReviewSummaries } from "@/lib/journey";
import { withReviewLines } from "@/lib/reviews-ui";
import { config, isPilotPreview, isPreview } from "@/lib/config";
import { dayOption, parseDateParam, parseGuestsParam, upcomingDays } from "@/lib/date-filter";
import { filterExperienceSummaries, normalizeExperienceDate, normalizeExperienceQuery, normalizeExperienceTheme, type SearchParams } from "@/lib/filters";
import { EXPERIENCE_LIST_DESCRIPTION, EXPERIENCE_LIST_TITLE, publicMetadata } from "@/lib/public-metadata";
import { englishAlternates } from "@/lib/locale-metadata";
import { guideCatalogForSite } from "@/lib/guide-registry";

export async function generateMetadata({ searchParams }: { searchParams: Promise<SearchParams> }): Promise<Metadata> {
  const query = await searchParams;
  const filtered = query.theme !== undefined || query.date !== undefined || query.guests !== undefined || normalizeExperienceQuery(query.q) !== "";
  return {
    ...publicMetadata(EXPERIENCE_LIST_TITLE, EXPERIENCE_LIST_DESCRIPTION, `${config.siteUrl}/experiences`), alternates: await englishAlternates("/experiences"),
    ...(filtered ? { robots: { index: false, follow: true } } : {}),
  };
}

/** Date chips cover a week; the home finder offers two weeks, so a later date from there gets its own chip. */
const CHIP_DAYS = 7;
const FINDER_DAYS = 14;

export default async function ExperiencesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const query = await searchParams;
  const searchQuery = normalizeExperienceQuery(query.q);
  const [api, result, guideCatalogResult] = await Promise.all([getApi(query), listExperiencesForSite("kamakura", query), guideCatalogForSite()]);
  const copy = EN_STATIC_COPY_V1;
  if (!result.ok && result.kind !== "not_found") return <ErrorState title="We couldn't load experiences" />;
  const catalog = result.ok ? result.data.experiences : [];
  const items = filterExperienceSummaries(catalog, searchQuery);
  const cards = withReviewLines(buildCardModels(items, await loadDetails(api, items, config.publicApiVersion !== "1.0"), isPilotPreview), await getReviewSummaries(items.map((item) => item.slug)));

  const now = new Date();
  const finderDays = upcomingDays(now, FINDER_DAYS);
  const catalogDate = config.publicApiVersion === "1.2" ? normalizeExperienceDate(query.date) : undefined;
  const initialDate = catalogDate ?? parseDateParam(query.date, finderDays);
  const theme = config.publicApiVersion === "1.2" ? normalizeExperienceTheme(query.theme) : undefined;
  const date = config.publicApiVersion === "1.2" ? normalizeExperienceDate(query.date) : undefined;
  const initialGuests = parseGuestsParam(query.guests);
  const days = upcomingDays(now, CHIP_DAYS);
  if (initialDate && !days.some((day) => day.key === initialDate)) days.push(dayOption(initialDate));

  const searchProps = {
    searchQuery,
    theme,
    date: initialDate ?? undefined,
    guests: initialGuests,
    filtersEnabled: config.publicApiVersion === "1.2",
    filtersActive: Boolean(searchQuery || theme || date || initialGuests !== null),
  };
  const listContent = (
    <CatalogueViewV1 copy={copy} heading="Kamakura experiences with local hosts" intro="Small groups, hosted by people who live here. One hour from Tokyo, two minutes from Kamakura Station." content={
      <ExperienceList
        key={JSON.stringify([searchQuery, theme, initialDate, initialGuests])}
        cards={cards}
        days={days}
        initialDate={initialDate}
        initialGuests={initialGuests}
        browseContext={{ q: searchQuery || undefined, theme }}
        catalogDateFiltered={config.publicApiVersion === "1.2" && Boolean(date)}
        preview={isPreview}
        nihoWebOrigin={config.nihoWebOrigin}
        search={<ExperienceFiltersForm key="bar-search" {...searchProps} placement="bar" />}
        inlineSearch={<ExperienceFiltersForm key="inline-search" {...searchProps} placement="inline" />}
        columns="three"
        empty={<EmptyResults key="empty-results" clearHref={searchQuery || theme || date || initialGuests !== null ? "/experiences" : null} searchActive={Boolean(searchQuery)} />}
      />
    } />
  );
  return <>
    <TrackView event="list_view" props={{ theme: theme ?? "all", date_filtered: initialDate !== null, result_count: items.length }} />
    {listContent}
    {guideCatalogResult.guides.length ? (
      <section className="container-page pt-16 lg:pt-[88px]" aria-labelledby="catalogue-guides-heading">
        <div className="mb-5 flex items-end justify-between gap-4">
          <div><p className="eyebrow">Guides</p><h2 id="catalogue-guides-heading" className="mt-1 text-[2rem] lg:text-[2.75rem]">Plan your day</h2></div>
          <Link href="/guides" className="link-leaf shrink-0 text-sm">See all guides</Link>
        </div>
        <GuideTeasers guides={guideCatalogResult.guides.slice(0, 3)} draftSlugs={guideCatalogResult.draftSlugs} columns="three" descriptions={false} />
      </section>
    ) : null}
  </>;
}
