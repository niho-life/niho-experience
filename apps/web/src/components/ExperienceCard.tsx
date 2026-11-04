"use client";

import { ExperienceCardV1, InviteCardV1, type ExperienceCardModelV1 } from "@niho/experience-presentation/v1";
import type { CardModel } from "@/lib/card-model";
import { browseHref, type BrowseContext } from "@/lib/browse-context";
import { imageAlt } from "@/lib/experience-copy";
import { CardDates, type CardDatesSource } from "./CardDates";
import { PRESENTATION_PRIMITIVES_V1 } from "./PresentationV1";
import { localeHref, useSiteCopy, useSiteLocale } from "./SiteLocale";

export type CardOptions = {
  /** List page: 2-line lead and a 4:3 cover on phones. */
  variant?: "home" | "list";
  priority?: boolean;
  /** Where the next dates come from (the list's own read, or a read by the card). Without it the weekday summary shows. */
  dates?: CardDatesSource;
  /** "Sat 24 Oct · 6:00 PM" when a date is chosen on the list. */
  highlight?: string | null;
  browseContext?: Partial<BrowseContext>;
  offerId?: string;
};

/** One whole-card link (the title's link covers the card). No popularity, scarcity or review claims. */
export function ExperienceCard({ card, variant = "home", priority = false, dates = { kind: "given", occurrences: null }, highlight = null, browseContext = {}, offerId }: { card: CardModel } & CardOptions) {
  const { copy, locale } = useSiteLocale();
  const model: ExperienceCardModelV1 = {
    ...card,
    href: localeHref(browseHref(`/experiences/${card.slug}`, browseContext, offerId), locale),
    cover: card.cover ? { src: card.cover.url, alt: imageAlt(card.cover, card.title) } : null,
    face: { ...card.face, image: card.face.image ? { src: card.face.image.url, alt: "" } : null },
    priceSuffix: ` ${copy.text("common.perAdult")}`,
  };
  return <ExperienceCardV1 card={model} variant={variant} priority={priority} highlight={highlight} dates={<CardDates slug={card.slug} scheduleLabel={card.scheduleLabel} source={dates} />} primitives={PRESENTATION_PRIMITIVES_V1} copy={copy} />;
}

/** Closing card on the home carousel: an invitation to host, not a listing. */
export function InviteCard() {
  return <InviteCardV1 primitives={PRESENTATION_PRIMITIVES_V1} copy={useSiteCopy()} />;
}

export function ExperienceGridSkeleton({ count = 3 }: { count?: number }) {
  return (
    <ul className="grid gap-x-6 gap-y-10 sm:grid-cols-2 lg:grid-cols-3" aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <li key={i} className="space-y-3">
          <div className="aspect-[4/5] animate-pulse rounded-[var(--radius-card)] bg-sand" />
          <div className="h-3 w-1/3 animate-pulse rounded bg-sand" />
          <div className="h-6 w-4/5 animate-pulse rounded bg-sand" />
        </li>
      ))}
    </ul>
  );
}
