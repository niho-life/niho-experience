import type { ExperienceCategoryId } from "@niho-experience/experience-domain";
import type { ReactNode } from "react";
import { HomeViewV1, type DisplayImageV1, type ExperienceCardModelV1, type HomeViewModelV1, type StaticCopyAccessorV1 } from "@niho/experience-presentation/v1";
import { CategoryTabs } from "@/components/CategoryTabs";
import { HomeHeroSlides } from "@/components/HomeHeroSlides";
import { HomeLivingRoom } from "@/components/HomeLivingRoom";
import { HomeSearchBar } from "@/components/HomeSearchBar";
import { PRESENTATION_PRIMITIVES_V1 } from "@/components/PresentationV1";
import { EmptyResults } from "@/components/States";
import { LocalizedLink } from "@/components/LocalizedLink";
import { ButtonLink } from "@/components/ui";
import type { CardModel, Face } from "@/lib/card-model";
import type { PublicImageForSite } from "@/lib/experience-types";
import { imageAlt } from "@/lib/experience-copy";
import { HOME_TEXT } from "@/lib/home-text";
import type { BookingSources } from "@/lib/booking-source";
import { siteNavigation } from "@/lib/site-nav";
import { pickHomeExperiences } from "@/lib/home";

/** What the English and the Japanese home both pass that this view does not own (the journal layout draws none of it, but the model type needs it). */
export type HomeRest = Omit<HomeViewModelV1, "cards" | "afterCards" | "empty" | "layout" | "finder" | "themes" | "cardsEyebrow" | "cardsTitle" | "heroMedia" | "heroHeading" | "heroHeadingClassName" | "heroBody" | "heroAction" | "afterHero" | "hideHostInvite" | "hostBandExtraAction">;

const displayImage = (image: PublicImageForSite | null, fallback = ""): DisplayImageV1 | null => image ? ({ src: image.url, alt: imageAlt(image, fallback) }) : null;
const displayFace = (face: Face) => ({ ...face, image: displayImage(face.image) });

function cardModel(card: CardModel, locale: "en" | "ja", priceSuffix: string): ExperienceCardModelV1 {
  return { ...card, href: `${locale === "ja" ? "/ja" : ""}/experiences/${card.slug}`, cover: displayImage(card.cover, card.title), face: displayFace(card.face), priceSuffix };
}

/**
 * The home, one component for both languages (#658): the English shape is the base; the words and the intended differences come from
 * `HOME_TEXT`. Sections, top to bottom: hero with the search bar over its bottom edge (#698), the category row, the experience cards (at most six, in the order picked), the three booking steps,
 * the living room (next to group inquiries when open), 街の人 (when there are people), the journal (when there are guides), the host band.
 */
export function HomePageView({ locale, copy, cards, search, rest, journal, people, categories = [], inquiry = false }: {
  locale: "en" | "ja";
  copy: StaticCopyAccessorV1;
  cards: readonly CardModel[];
  /** What the search bar needs: the days its calendar offers and where each card's availability is read (only once the day picker opens). */
  search: { windowStart: string; windowEnd: string; preview: boolean; bookingSources: BookingSources };
  rest: HomeRest;
  journal?: ReactNode;
  people?: ReactNode;
  categories?: readonly ExperienceCategoryId[];
  inquiry?: boolean;
}) {
  const text = HOME_TEXT[locale];
  const { groups, hostLogin } = siteNavigation(locale, { inquiry });
  const groupCard = groups && text.groupCard;
  const shown = pickHomeExperiences(cards);
  const model: HomeViewModelV1 = {
    ...rest,
    hero: text.heroAlt ? { ...rest.hero, alt: text.heroAlt } : rest.hero,
    heroMedia: <HomeHeroSlides />,
    heroHeading: text.heroHeading,
    heroHeadingClassName: text.heroHeadingClassName,
    heroBody: text.heroBody,
    // The search bar overlaps the hero's bottom edge (the package then keeps the hero at the height meant for an overlapping finder); the old hero button is gone.
    finder: <HomeSearchBar locale={locale} cards={cards.map((card) => ({ slug: card.slug, offers: card.offers }))} {...search} />,
    afterHero: <CategoryTabs variant="home" locale={locale} categories={categories} />,
    hideHostInvite: true,
    hostBandExtraAction: <p className="text-sm text-ink-soft">{text.registeredHost} <LocalizedLink href={hostLogin.href} className="font-bold underline underline-offset-4">{hostLogin.label}</LocalizedLink></p>,
    themes: [],
    cardsEyebrow: shown.length ? text.cardsEyebrow : undefined,
    cardsTitle: text.cardsTitle,
    // `dates` is an empty fragment on purpose: the package falls back to the weekday line when it is nullish, and the home shows no "next dates" (#698).
    cards: shown.map((card) => ({ model: cardModel(card, locale, text.priceSuffix), dates: <></> })),
    empty: <EmptyResults clearHref={null} />,
    afterCards: <>
      {groups && groupCard ? <div className="container-page mt-14 grid gap-4 md:grid-cols-2 lg:mt-[88px]">
        <HomeLivingRoom {...text.livingRoom} card />
        <section aria-labelledby="home-group-heading" className="flex flex-col justify-end rounded-[22px] bg-leaf-pale p-6 sm:p-8">
          <p className="hand text-[1.75rem]">{groupCard.hand}</p>
          <h2 id="home-group-heading" className="mt-1 text-[1.75rem] leading-tight sm:text-[2rem]">{groupCard.title}</h2>
          <p className="mt-3 max-w-[28rem] text-ink-soft">{groupCard.body}</p>
          <ul className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-3">
            {groups.links.map((link) => <li key={link.href}><ButtonLink href={link.href} variant="secondary">{link.label}</ButtonLink></li>)}
          </ul>
        </section>
      </div> : <HomeLivingRoom {...text.livingRoom} />}
      {people}{journal}
    </>,
    layout: "journal",
  };
  return <HomeViewV1 model={model} primitives={PRESENTATION_PRIMITIVES_V1} copy={copy} />;
}
