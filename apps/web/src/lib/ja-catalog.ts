import {
  EXPERIENCE_CATEGORIES, EMPTY_EXPERIENCE_CLASSIFICATION,
  type ExperienceCategoryId, type ExperienceClassification,
} from "@niho-experience/experience-domain";
import { providerKindFor, providerNameFor } from "./experience/provider-name";
import type { SitePublicExperience } from "./experience/site-publications";

/*
 * The Japanese site's list and cards (#529, #561): one card per published product that has Japanese text and a sale, with its
 * classification. Pure: the page reads the store and hands the rows here. English pages do not use any of this.
 */

export type JaCard = {
  readonly slug: string;
  readonly title: string;
  /** 「ひとこと」: the product's lead. */
  readonly lead: string;
  readonly cover: { readonly url: string; readonly alt: string } | null;
  /** 「◯◯さんと」 / 「◯◯が案内」: who the day is spent with, from the admin-confirmed public name. Null when none is confirmed. */
  readonly withLine: string | null;
  readonly face: { readonly url: string; readonly alt: string } | null;
  readonly durationMinutes: number | null;
  readonly capacity: { readonly min: number; readonly max: number } | null;
  readonly priceFromYen: number | null;
  readonly classification: ExperienceClassification;
  /** What the offers are sold for: the party-size filter. */
  readonly offers: readonly { readonly minimumParticipants: number; readonly maxPartySize: number; readonly weekdays: readonly number[] }[];
};

/**
 * 「◯◯さんが案内」 / 「◯◯・◯◯が案内」: the people the experience is met through on 街の人 (#585), at most three names. Empty when no
 * one is linked.
 */
export function jaGuideLine(names: readonly string[]): string | null {
  const shown = names.map((name) => name.trim()).filter(Boolean).slice(0, 3);
  if (shown.length === 0) return null;
  return shown.length === 1 ? `${shown[0]}さんが案内` : `${shown.join("・")}が案内`;
}

/**
 * The card of a published, saleable product with Japanese text, or null (it is not on the Japanese list). `people`: the people on
 * 街の人 this experience is met through (#585); when there are any, the card says they guide it, in place of the provider's name.
 */
export function jaCardOf(item: SitePublicExperience, classification: ExperienceClassification | undefined, people: readonly { readonly name: string; readonly photo?: { readonly src: string } }[] = []): JaCard | null {
  const japanese = item.publication.japanese;
  const offers = item.saleTerms?.offers ?? [];
  if (!japanese || offers.length === 0) return null;
  const name = providerNameFor(item.publication, "ja");
  const kind = providerKindFor(item.publication, item.sellerDisclosure?.sellerKind);
  const photo = item.publication.photos[0];
  const face = item.publication.providerPhoto;
  const durations = offers.map((offer) => offer.durationMinutes);
  return {
    slug: item.publication.slug,
    title: japanese.title,
    lead: japanese.lead,
    cover: photo ? { url: photo.src, alt: photo.altJa || `${japanese.title}の写真` } : null,
    withLine: jaGuideLine(people.map((entry) => entry.name)) ?? (name ? (kind === "PERSON" ? `${name}さんと` : kind === "BUSINESS" ? `${name}が案内` : `ホスト：${name}`) : null),
    // The face on the card is the first person it is met through (the name beside it is theirs); the provider's own photo only when nobody is linked.
    face: people[0]?.photo ? { url: people[0].photo.src, alt: "" } : face ? { url: face.src, alt: "" } : null,
    durationMinutes: Math.min(...durations),
    capacity: { min: Math.min(...offers.map((offer) => offer.minimumParticipants)), max: Math.max(...offers.map((offer) => offer.maxPartySize)) },
    priceFromYen: Math.min(...offers.map((offer) => offer.pricing.adultPriceYen)),
    classification: classification ?? EMPTY_EXPERIENCE_CLASSIFICATION,
    offers: offers.map((offer) => ({ minimumParticipants: offer.minimumParticipants, maxPartySize: offer.maxPartySize, weekdays: offer.weekdays })),
  };
}

export const jaYen = (amount: number): string => `¥${amount.toLocaleString("ja-JP")}`;

/** How many published cards each category has: a category without any is not offered to search engines. */
export function jaCategoryCounts(cards: readonly JaCard[]): ReadonlyMap<ExperienceCategoryId, number> {
  const counts = new Map<ExperienceCategoryId, number>();
  for (const card of cards) if (card.classification.category) counts.set(card.classification.category, (counts.get(card.classification.category) ?? 0) + 1);
  return counts;
}

export { EXPERIENCE_CATEGORIES };
