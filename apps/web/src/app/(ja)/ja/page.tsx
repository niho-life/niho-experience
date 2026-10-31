import type { Metadata } from "next";
import { HomeViewV1, type ExperienceCardModelV1, type HomeViewModelV1 } from "@niho/experience-presentation/v1";
import { EmptyResults } from "@/components/States";
import { JapaneseUnavailable } from "@/components/JapaneseUnavailable";
import { CardDates, type CardDatesSource } from "@/components/CardDates";
import { guestBookingSources } from "@/lib/guest-booking-source";
import { HomeFinder } from "@/components/HomeFinder";
import { PRESENTATION_PRIMITIVES_V1 } from "@/components/PresentationV1";
import { getApi } from "@/lib/api";
import { buildCardModels } from "@/lib/card-model";
import type { CardModel } from "@/lib/card-model";
import { loadDetails } from "@/lib/catalog";
import { upcomingDays } from "@/lib/date-filter";
import { imageAlt } from "@/lib/experience-copy";
import { assertSameJapaneseRelease, getJapaneseCatalog, getJapaneseCopy } from "@/lib/localized-content";
import { japaneseStaticMetadata } from "@/lib/locale-metadata";
import { BANNER_VIDEO, HERO_PHOTO, HOST_BAND_VIDEO, POSTCARDS } from "@/lib/site-media";

const cardModel = (card: CardModel): ExperienceCardModelV1 => ({
  ...card,
  href: `/experiences/${card.slug}`,
  cover: card.cover ? { src: card.cover.url, alt: imageAlt(card.cover, card.title) } : null,
  face: { ...card.face, image: card.face.image ? { src: card.face.image.url, alt: imageAlt(card.face.image, card.face.name) } : null },
  priceSuffix: " / 大人",
});

export async function generateMetadata(): Promise<Metadata> {
  try { return await japaneseStaticMetadata("home"); }
  catch { return { title: "Japanese version unavailable", robots: { index: false, follow: false } }; }
}

export default async function JapaneseHome() {
  let data;
  try {
    const [copy, catalog, api] = await Promise.all([getJapaneseCopy(), getJapaneseCatalog(), getApi()]);
    assertSameJapaneseRelease(copy.releaseId, catalog);
    const details = await loadDetails(api, catalog.experiences, true, "ja", copy.releaseId);
    const cards = buildCardModels(catalog.experiences, details, false, "ja", copy.copy);
    data = { copy, catalog, cards };
  } catch { return <JapaneseUnavailable />; }
  const { copy, cards } = data;
  const cardDates: CardDatesSource = { kind: "read", preview: false, sources: await guestBookingSources(cards.map((card) => card.slug)) };
  const model: HomeViewModelV1 = {
    hero: { src: HERO_PHOTO.src, alt: HERO_PHOTO.alt, position: HERO_PHOTO.position },
    finder: <HomeFinder days={upcomingDays(new Date(), 14, "ja")} />,
    // Editorial theme labels are English-only until they join the approved copy release.
    themes: [],
    cardsEyebrow: `${cards.length}件`,
    cards: cards.map((card) => ({ model: cardModel(card), dates: <CardDates slug={card.slug} scheduleLabel={card.scheduleLabel} source={cardDates} /> })),
    empty: <EmptyResults clearHref={null} />,
    strips: [],
    stripsEyebrow: "",
    banner: { src: BANNER_VIDEO.src, poster: BANNER_VIDEO.poster },
    figures: [{ value: String(cards.length), unit: copy.copy.text(cards.length === 1 ? "home.wayToStartUnit" : "home.waysToStartUnit"), note: copy.copy.text("home.hostedNote") }],
    postcards: POSTCARDS.map((postcard) => ({ id: postcard.src, image: { src: postcard.src, alt: postcard.alt, position: postcard.position }, place: postcard.place, rotate: postcard.rotate })),
    hostBand: { src: HOST_BAND_VIDEO.src, poster: HOST_BAND_VIDEO.poster },
  };
  return <HomeViewV1 model={model} primitives={PRESENTATION_PRIMITIVES_V1} copy={copy.copy} />;
}
