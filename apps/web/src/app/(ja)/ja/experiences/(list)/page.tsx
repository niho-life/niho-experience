import type { Metadata } from "next";
import { CatalogueViewV1 } from "@niho/experience-presentation/v1";
import { ExperienceList } from "@/components/ExperienceList";
import { ExperienceFiltersForm } from "@/components/ExperienceFiltersForm";
import { EmptyResults } from "@/components/States";
import { JapaneseUnavailable } from "@/components/JapaneseUnavailable";
import { getApi } from "@/lib/api";
import { config } from "@/lib/config";
import { listPublicationSummaries } from "@/lib/experience/publication-site";
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

export async function generateMetadata({ searchParams }: { searchParams: Promise<SearchParams> }): Promise<Metadata> {
  try {
    const query = await searchParams;
    const filtered = query.date !== undefined || query.guests !== undefined || normalizeExperienceQuery(query.q) !== "";
    if (config.apiMode === "http") return { title: "鎌倉の体験", description: "鎌倉の少人数制の体験を探せます。", alternates: { canonical: `${config.siteUrl}/ja/experiences`, languages: { en: `${config.siteUrl}/experiences`, ja: `${config.siteUrl}/ja/experiences`, "x-default": `${config.siteUrl}/experiences` } }, robots: filtered ? { index: false, follow: true } : undefined };
    return await japaneseStaticMetadata("experiences", filtered);
  } catch { return { title: "Japanese experiences unavailable", robots: { index: false, follow: false } }; }
}

const CHIP_DAYS = 7;
const FINDER_DAYS = 14;

export default async function JapaneseExperiencesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const query = await searchParams;
  let data;
  try {
    const [copy, api] = await Promise.all([getJapaneseCopy(), getApi()]);
    let catalog: ExperienceSummaryForSite[];
    if (config.apiMode === "http") catalog = await listPublicationSummaries("kamakura", "ja");
    else { const selected = await getJapaneseCatalog(); assertSameJapaneseRelease(copy.releaseId, selected); catalog = selected.experiences; }
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
