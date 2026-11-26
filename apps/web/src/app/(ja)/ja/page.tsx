import type { Metadata } from "next";
import { JapaneseUnavailable } from "@/components/JapaneseUnavailable";
import { PeopleBand } from "@/components/ja-home/JapaneseHomeSections";
import { HomeJournal } from "@/components/HomeJournal";
import { buttonClass } from "@/components/ui";
import { HomePageView, type HomeRest } from "@/components/pages/HomePageView";
import type { CardDatesSource } from "@/components/CardDates";
import type { CardModel } from "@/lib/card-model";
import { sitePublicationCard } from "@/lib/experience/site-card-model";
import { listSitePublicExperiences } from "@/lib/experience/site-publications";
import { guestBookingSources } from "@/lib/guest-booking-source";
import { loadSiteCategories } from "@/lib/site-categories";
import { groupInquiryOpen } from "@/lib/group-inquiry-links";
import { JA_HOME_FACES_LIMIT, pickFeaturedPerson } from "@/lib/ja-home";
import { loadJapaneseGuides } from "@/lib/ja-guides";
import { homeJournal } from "@/lib/home-journal";
import { loadPeople, loadPeoplePages } from "@/lib/ja-people";
import { peopleByExperience } from "@/lib/ja-people-links";
import { getReviewSummaries } from "@/lib/journey";
import type { StaticCopyAccessorV1 } from "@niho/experience-presentation/v1";
import { getJapaneseCopy } from "@/lib/localized-content";
import { japaneseStaticMetadata } from "@/lib/locale-metadata";
import { withReviewLines } from "@/lib/reviews-ui";
import { BANNER_VIDEO, HERO_PHOTO, HOST_BAND_VIDEO, POSTCARDS } from "@/lib/site-media";

export async function generateMetadata(): Promise<Metadata> {
  try { return await japaneseStaticMetadata("home"); }
  catch { return { title: "Japanese version unavailable", robots: { index: false, follow: false } }; }
}

// 英語のトップと同じ部品（`HomePageView`）が描く。journal の構成では出ない項目（特集・帯・数字・絵はがき）は、型のために空か既定を渡す。
const REST: HomeRest = {
  hero: { src: HERO_PHOTO.src, alt: HERO_PHOTO.alt, position: HERO_PHOTO.position },
  strips: [],
  stripsEyebrow: "",
  banner: { src: BANNER_VIDEO.src, poster: BANNER_VIDEO.poster },
  figures: [],
  postcards: POSTCARDS.map((postcard) => ({ id: postcard.src, image: { src: postcard.src, alt: postcard.alt, position: postcard.position }, place: postcard.place, rotate: postcard.rotate })),
  hostBand: { src: HOST_BAND_VIDEO.src, poster: HOST_BAND_VIDEO.poster },
};

/**
 * 日本語のトップ（#563、#658）。英語のトップと同じ1つの部品で、文言と意図した差だけが違う（`lib/home-text.tsx`）。体験のカードは英語と同じ
 * `ExperienceCardV1`（次の開催日つき）。中身がまだ無いまとまり（載っている人が0人・公開中の記事が無い）は出さない。
 */
export default async function JapaneseHome() {
  let copy: StaticCopyAccessorV1;
  let cards: CardModel[];
  try {
    copy = (await getJapaneseCopy()).copy;
    const [catalog, people] = await Promise.all([listSitePublicExperiences("ja"), loadPeople()]);
    const guides = peopleByExperience(people);
    cards = catalog.experiences.flatMap((item) => {
      const card = sitePublicationCard(item, "ja", { people: guides.get(item.publication.slug) ?? [], copy });
      return card ? [card] : [];
    });
  } catch { return <JapaneseUnavailable />; }
  const [peopleOnPages, allGuides, categories] = await Promise.all([loadPeoplePages(), loadJapaneseGuides(), loadSiteCategories("ja")]);
  cards = withReviewLines(cards, await getReviewSummaries(cards.map((card) => card.slug)), "ja");
  const cardDates: CardDatesSource = { kind: "read", preview: false, sources: await guestBookingSources(cards.map((card) => card.slug)) };
  const featured = pickFeaturedPerson(peopleOnPages);
  const journal = homeJournal(allGuides, { locale: "ja" });
  const journalNode = journal.items.length ? <HomeJournal journal={journal} locale="ja" allHref="/ja/guides" moreClassName={buttonClass("secondary")} /> : undefined;
  return <HomePageView
    locale="ja" copy={copy} cards={cards} cardDates={cardDates} rest={REST}
    people={featured ? <PeopleBand featured={featured} people={peopleOnPages} facesLimit={JA_HOME_FACES_LIMIT} /> : undefined}
    categories={categories} inquiry={groupInquiryOpen()}
    journal={journalNode}
  />;
}
