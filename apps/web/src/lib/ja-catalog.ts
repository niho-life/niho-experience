import {
  EXPERIENCE_AREAS, EXPERIENCE_CATEGORIES, EXPERIENCE_COMPANIONS, EXPERIENCE_OCCASIONS, EMPTY_EXPERIENCE_CLASSIFICATION,
  experienceAreaLabel, isExperienceAreaId, isExperienceCategoryId,
  type ExperienceAreaId, type ExperienceCategoryId, type ExperienceClassification, type ExperienceCompanionId, type ExperienceOccasionId,
} from "@niho-experience/experience-domain";
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
  /** What the offers are sold for: the date filter's fast path and the guests filter. */
  readonly offers: readonly { readonly minimumParticipants: number; readonly maxPartySize: number; readonly weekdays: readonly number[] }[];
};

/** The card of a published, saleable product with Japanese text, or null (it is not on the Japanese list). */
export function jaCardOf(item: SitePublicExperience, classification: ExperienceClassification | undefined): JaCard | null {
  const japanese = item.publication.japanese;
  const offers = item.saleTerms?.offers ?? [];
  if (!japanese || offers.length === 0) return null;
  const name = item.publication.providerPublicName?.trim();
  const person = item.publication.providerKind === "PERSON";
  const photo = item.publication.photos[0];
  const face = item.publication.providerPhoto;
  const durations = offers.map((offer) => offer.durationMinutes);
  return {
    slug: item.publication.slug,
    title: japanese.title,
    lead: japanese.lead,
    cover: photo ? { url: photo.src, alt: photo.altJa || `${japanese.title}の写真` } : null,
    withLine: name ? (person ? `${name}さんと` : `${name}が案内`) : null,
    face: face ? { url: face.src, alt: "" } : null,
    durationMinutes: Math.min(...durations),
    capacity: { min: Math.min(...offers.map((offer) => offer.minimumParticipants)), max: Math.max(...offers.map((offer) => offer.maxPartySize)) },
    priceFromYen: Math.min(...offers.map((offer) => offer.pricing.adultPriceYen)),
    classification: classification ?? EMPTY_EXPERIENCE_CLASSIFICATION,
    offers: offers.map((offer) => ({ minimumParticipants: offer.minimumParticipants, maxPartySize: offer.maxPartySize, weekdays: offer.weekdays })),
  };
}

/** 「3時間」「1時間30分」「45分」. */
export function jaDuration(minutes: number): string {
  if (minutes < 60) return `${minutes}分`;
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  return rest === 0 ? `${hours}時間` : `${hours}時間${rest}分`;
}

/** 「2〜8名」, or 「4名」 when it is one number. */
export function jaCapacity(capacity: { min: number; max: number }): string {
  return capacity.min === capacity.max ? `${capacity.max}名` : `${capacity.min}〜${capacity.max}名`;
}

export const jaYen = (amount: number): string => `¥${amount.toLocaleString("ja-JP")}`;

export const JA_GUEST_CHOICES = [1, 2, 3, 4, 5, 6, 8, 10, 20] as const;

export type JaListQuery = {
  readonly category: ExperienceCategoryId | null;
  readonly area: ExperienceAreaId | null;
  readonly companion: ExperienceCompanionId | null;
  readonly occasion: ExperienceOccasionId | null;
  readonly guests: number | null;
  /** YYYY-MM-DD, one of the offered days. */
  readonly date: string | null;
};

type Params = Record<string, string | string[] | undefined>;
const one = (value: string | string[] | undefined): string | null => (typeof value === "string" ? value : null);

/** The list's own query: a value that is not one of the choices is the same as no value. */
export function parseJaListQuery(params: Params, days: readonly { readonly key: string }[]): JaListQuery {
  const category = one(params.category), area = one(params.area), companion = one(params.with), occasion = one(params.occasion), guests = one(params.guests), date = one(params.date);
  return {
    category: isExperienceCategoryId(category) ? category : null,
    area: isExperienceAreaId(area) ? area : null,
    companion: EXPERIENCE_COMPANIONS.find((item) => item.id === companion)?.id ?? null,
    occasion: EXPERIENCE_OCCASIONS.find((item) => item.id === occasion)?.id ?? null,
    guests: guests !== null && /^\d{1,2}$/.test(guests) && (JA_GUEST_CHOICES as readonly number[]).includes(Number(guests)) ? Number(guests) : null,
    date: date !== null && days.some((day) => day.key === date) ? date : null,
  };
}

/** The list's address for a query (the category, and any other condition, as `?` parameters). */
export function jaListHref(query: JaListQuery, override: Partial<{ [K in keyof JaListQuery]: JaListQuery[K] | null }> = {}): string {
  const next = { ...query, ...override };
  const params = new URLSearchParams();
  if (next.category) params.set("category", next.category);
  if (next.date) params.set("date", next.date);
  if (next.area) params.set("area", next.area);
  if (next.companion) params.set("with", next.companion);
  if (next.occasion) params.set("occasion", next.occasion);
  if (next.guests) params.set("guests", String(next.guests));
  const text = params.toString();
  return text ? `/ja/experiences?${text}` : "/ja/experiences";
}

/** Whether any condition besides the category is set (such a list is not for search engines). */
export const jaQueryHasFilter = (query: JaListQuery): boolean => Boolean(query.area || query.companion || query.occasion || query.guests || query.date);

/** The cards that meet every condition but the date (the date is decided by availability, or by weekday as a fast pre-check). */
export function filterJaCards(cards: readonly JaCard[], query: JaListQuery): JaCard[] {
  return cards.filter((card) => {
    const c = card.classification;
    if (query.category && c.category !== query.category) return false;
    if (query.area && c.area !== query.area) return false;
    if (query.companion && !c.companions.includes(query.companion)) return false;
    if (query.occasion && !c.occasions.includes(query.occasion)) return false;
    if (query.guests && !card.offers.some((offer) => offer.minimumParticipants <= query.guests! && query.guests! <= offer.maxPartySize)) return false;
    if (query.date) {
      const [y, m, d] = query.date.split("-").map(Number) as [number, number, number];
      const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
      if (!card.offers.some((offer) => offer.weekdays.includes(weekday))) return false;
    }
    return true;
  });
}

/** How many published cards each category has: a category without any is not offered to search engines. */
export function jaCategoryCounts(cards: readonly JaCard[]): ReadonlyMap<ExperienceCategoryId, number> {
  const counts = new Map<ExperienceCategoryId, number>();
  for (const card of cards) if (card.classification.category) counts.set(card.classification.category, (counts.get(card.classification.category) ?? 0) + 1);
  return counts;
}

export const jaCategoryOf = (id: ExperienceCategoryId | null) => EXPERIENCE_CATEGORIES.find((item) => item.id === id) ?? null;
export const jaAreaLabel = (id: ExperienceAreaId | null) => experienceAreaLabel(id);
export { EXPERIENCE_AREAS, EXPERIENCE_CATEGORIES, EXPERIENCE_COMPANIONS, EXPERIENCE_OCCASIONS };
