import type { Metadata } from "next";
import { EXPERIENCE_CATEGORIES } from "@niho-experience/experience-domain";
import { JapaneseUnavailable } from "@/components/JapaneseUnavailable";
import { JaExperienceCard } from "@/components/ja/JaExperienceCard";
import { JapaneseHero } from "@/components/ja-home/JapaneseHero";
import { CategoryNav, ConsultBand, FeatureBand, GuidesBand, HomeFinder, HostBand, JapaneseHeroCopy, OccasionStrips, PeopleBand, PicksHeading } from "@/components/ja-home/JapaneseHomeSections";
import { groupInquiryOpen } from "@/lib/group-inquiry-links";
import {
  JA_HOME_FACES_LIMIT, JA_HOME_FEATURE, JA_HOME_GUIDES_LIMIT, JA_HOME_HAND, JA_HOME_HERO_PHOTOS, JA_HOME_LEAD, JA_HOME_TITLE,
  categoriesWithExperiences, occasionsWithExperiences, pickFeaturedPerson, pickHomeExperiences,
} from "@/lib/ja-home";
import { loadJaCards } from "@/lib/ja-catalog-server";
import { loadJapaneseGuides } from "@/lib/ja-guides";
import { loadPeople } from "@/lib/ja-people";
import { getJapaneseCopy } from "@/lib/localized-content";
import { japaneseStaticMetadata } from "@/lib/locale-metadata";

export async function generateMetadata(): Promise<Metadata> {
  try { return await japaneseStaticMetadata("home"); }
  catch { return { title: "Japanese version unavailable", robots: { index: false, follow: false } }; }
}

/**
 * 日本語のトップ（#563）。英語のトップの訳ではなく、日本語サイト独自の構成。上から：題と写真の入れ替え、さがす欄、カテゴリー、
 * おすすめの体験、特集、どんな日に、街の人、相談、読みもの、体験を載せる。中身がまだ無いまとまり（体験が0件のカテゴリー・
 * 該当の無い「どんな日に」・載っている人が0人・公開中の記事が無い）は、空の枠を見せずに出さない。体験のカードは一覧と同じ
 * （`JaExperienceCard`）で、予約の方式や販売者の札は並べない。
 */
export default async function JapaneseHome() {
  let cards;
  try {
    await getJapaneseCopy();
    cards = await loadJaCards();
  } catch { return <JapaneseUnavailable />; }
  const [people, allGuides] = await Promise.all([loadPeople(), loadJapaneseGuides()]);
  const picks = pickHomeExperiences(cards);
  const categories = categoriesWithExperiences(EXPERIENCE_CATEGORIES, cards);
  const occasions = occasionsWithExperiences(cards);
  const featured = pickFeaturedPerson(people);
  const guides = allGuides.slice(0, JA_HOME_GUIDES_LIMIT);
  return <>
    <JapaneseHero photos={JA_HOME_HERO_PHOTOS}><JapaneseHeroCopy title={JA_HOME_TITLE} hand={JA_HOME_HAND} lead={JA_HOME_LEAD} /></JapaneseHero>
    {cards.length ? <HomeFinder categories={categories} /> : null}
    {categories.length ? <CategoryNav categories={categories} /> : null}
    {picks.length ? <section aria-labelledby="picks" className="container-page mt-14 sm:mt-16">
      <div id="picks"><PicksHeading total={cards.length} /></div>
      <div className="mt-7 grid gap-x-6 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
        {picks.map((card, index) => <JaExperienceCard key={card.slug} card={card} priority={index < 3} />)}
      </div>
    </section> : null}
    {categories.some((category) => category.id === JA_HOME_FEATURE.categoryId) ? <FeatureBand /> : null}
    {occasions.length ? <OccasionStrips items={occasions} /> : null}
    {featured ? <PeopleBand featured={featured} people={people} facesLimit={JA_HOME_FACES_LIMIT} /> : null}
    {groupInquiryOpen() ? <ConsultBand /> : null}
    {guides.length ? <GuidesBand guides={guides} /> : null}
    <HostBand />
  </>;
}
