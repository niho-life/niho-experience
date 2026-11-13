import type { Metadata } from "next";
import { JapaneseUnavailable } from "@/components/JapaneseUnavailable";
import type { CardDatesSource } from "@/components/CardDates";
import { ExperienceCard } from "@/components/ExperienceCard";
import { JapaneseHero } from "@/components/ja-home/JapaneseHero";
import { ConsultBand, HostBand, JapaneseHeroCopy, PeopleBand, PicksHeading } from "@/components/ja-home/JapaneseHomeSections";
import { guestBookingSources } from "@/lib/guest-booking-source";
import { groupInquiryOpen } from "@/lib/group-inquiry-links";
import { getApi } from "@/lib/api";
import { config } from "@/lib/config";
import { listPublicationSummaries } from "@/lib/experience/publication-site";
import { buildCardModels } from "@/lib/card-model";
import { loadDetails } from "@/lib/catalog";
import { JA_HOME_FACES_LIMIT, JA_HOME_HAND, JA_HOME_HERO_PHOTOS, JA_HOME_LEAD, JA_HOME_TITLE, pickFeaturedPerson, pickHomeExperiences } from "@/lib/ja-home";
import { loadPeople } from "@/lib/ja-people";
import { assertSameJapaneseRelease, getJapaneseCatalog, getJapaneseCopy } from "@/lib/localized-content";
import { japaneseStaticMetadata } from "@/lib/locale-metadata";
import { getReviewSummaries } from "@/lib/journey";
import { withReviewLines } from "@/lib/reviews-ui";

export async function generateMetadata(): Promise<Metadata> {
  try { return await japaneseStaticMetadata("home"); }
  catch { return { title: "Japanese version unavailable", robots: { index: false, follow: false } }; }
}

/**
 * 日本語のトップ（#563）。英語のトップの訳ではなく、日本語サイト独自の構成：題と写真の入れ替え、おすすめの体験、相談、体験を載せる。
 * さがす欄・カテゴリー・どんな日に（#529）、街の人（#564）、読みもの（#154）は、それぞれが main に入ってから、ここに足す
 * （空の枠は見せない）。
 */
export default async function JapaneseHome() {
  let data;
  try {
    const [copy, api] = await Promise.all([getJapaneseCopy(), getApi()]);
    const catalog = config.apiMode === "http" ? await listPublicationSummaries("kamakura", "ja") : await getJapaneseCatalog();
    if (!Array.isArray(catalog)) assertSameJapaneseRelease(copy.releaseId, catalog);
    const summaries = Array.isArray(catalog) ? catalog : catalog.experiences;
    const picked = pickHomeExperiences(summaries);
    const details = await loadDetails(api, picked, true, "ja", copy.releaseId);
    const plainCards = buildCardModels(picked, details, false, "ja", copy.copy);
    const cards = withReviewLines(plainCards, await getReviewSummaries(plainCards.map((card) => card.slug)), "ja");
    data = { cards, total: summaries.length };
  } catch { return <JapaneseUnavailable />; }
  const { cards, total } = data;
  const cardDates: CardDatesSource = { kind: "read", preview: false, sources: await guestBookingSources(cards.map((card) => card.slug)) };
  // 街の人：載っている人が0人なら、まとまりごと出さない。
  const people = await loadPeople();
  const featured = pickFeaturedPerson(people);
  return <>
    <JapaneseHero photos={JA_HOME_HERO_PHOTOS}><JapaneseHeroCopy title={JA_HOME_TITLE} hand={JA_HOME_HAND} lead={JA_HOME_LEAD} /></JapaneseHero>
    {cards.length ? <section aria-labelledby="picks" className="container-page mt-14 sm:mt-16">
      <div id="picks"><PicksHeading total={total} /></div>
      <div className="mt-7 grid gap-x-6 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map((card, index) => <ExperienceCard key={card.slug} card={card} variant="home" priority={index < 3} dates={cardDates} />)}
      </div>
    </section> : null}
    {featured ? <PeopleBand featured={featured} people={people} facesLimit={JA_HOME_FACES_LIMIT} /> : null}
    {groupInquiryOpen() ? <ConsultBand /> : null}
    <HostBand />
  </>;
}
