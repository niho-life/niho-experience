import type { ReactNode } from "react";
import { HomeViewV1, type DisplayImageV1, type ExperienceCardModelV1, type HomeViewModelV1, type StaticCopyAccessorV1 } from "@niho/experience-presentation/v1";
import { CardDates, type CardDatesSource } from "@/components/CardDates";
import { HomeHeroSlides } from "@/components/HomeHeroSlides";
import { HomeLivingRoom } from "@/components/HomeLivingRoom";
import { PRESENTATION_PRIMITIVES_V1 } from "@/components/PresentationV1";
import { EmptyResults } from "@/components/States";
import { ButtonLink } from "@/components/ui";
import type { CardModel, Face } from "@/lib/card-model";
import type { PublicImageForSite } from "@/lib/experience-types";
import { imageAlt } from "@/lib/experience-copy";
import { HOME_TEXT } from "@/lib/home-text";
import { pickHomeExperiences } from "@/lib/ja-home";

/** What the English and the Japanese home both pass that this view does not own (the journal layout draws none of it, but the model type needs it). */
export type HomeRest = Omit<HomeViewModelV1, "cards" | "afterCards" | "empty" | "layout" | "finder" | "themes" | "cardsEyebrow" | "cardsTitle" | "heroMedia" | "heroHeading" | "heroHeadingClassName" | "heroBody" | "heroAction">;

const displayImage = (image: PublicImageForSite | null, fallback = ""): DisplayImageV1 | null => image ? ({ src: image.url, alt: imageAlt(image, fallback) }) : null;
const displayFace = (face: Face) => ({ ...face, image: displayImage(face.image) });

function cardModel(card: CardModel, locale: "en" | "ja", priceSuffix: string): ExperienceCardModelV1 {
  return { ...card, href: `${locale === "ja" ? "/ja" : ""}/experiences/${card.slug}`, cover: displayImage(card.cover, card.title), face: displayFace(card.face), priceSuffix };
}

/**
 * The home, one component for both languages (#658): the English shape is the base; the words and the intended differences come from
 * `HOME_TEXT`. Sections, top to bottom: hero, the experience cards (at most six, in the order picked), the three booking steps,
 * the living room, 街の人 (when there are people), the consultation band (when open), the journal (when there are guides), the host band.
 */
export function HomePageView({ locale, copy, cards, cardDates, rest, journal, people, consult }: {
  locale: "en" | "ja";
  copy: StaticCopyAccessorV1;
  cards: readonly CardModel[];
  cardDates: CardDatesSource;
  rest: HomeRest;
  journal?: ReactNode;
  people?: ReactNode;
  consult?: ReactNode;
}) {
  const text = HOME_TEXT[locale];
  const shown = pickHomeExperiences(cards);
  const model: HomeViewModelV1 = {
    ...rest,
    hero: text.heroAlt ? { ...rest.hero, alt: text.heroAlt } : rest.hero,
    heroMedia: <HomeHeroSlides />,
    heroHeading: text.heroHeading,
    heroHeadingClassName: text.heroHeadingClassName,
    heroBody: text.heroBody,
    heroAction: <ButtonLink href={text.heroAction.href}>{text.heroAction.label}</ButtonLink>,
    finder: null,
    themes: [],
    cardsEyebrow: shown.length ? text.cardsEyebrow : undefined,
    cardsTitle: text.cardsTitle,
    cards: shown.map((card) => ({ model: cardModel(card, locale, text.priceSuffix), dates: <CardDates slug={card.slug} scheduleLabel={card.scheduleLabel} source={cardDates} /> })),
    empty: <EmptyResults clearHref={null} />,
    afterCards: <><HomeLivingRoom {...text.livingRoom} />{people}{consult}{journal}</>,
    layout: "journal",
  };
  return <HomeViewV1 model={model} primitives={PRESENTATION_PRIMITIVES_V1} copy={copy} />;
}
