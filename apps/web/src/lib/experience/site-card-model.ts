import { japaneseListPublication } from "@/lib/experience-list-catalog";
import { providerNameFor } from "./provider-name";
import type { SitePublicExperience, SitePublicOffer } from "./site-publications";
import type { CardModel } from "@/lib/card-model";
import type { StaticCopyAccessorV1 } from "@niho/experience-presentation/v1";
import { formatDuration, formatYen } from "@/lib/format";
import { formatClock, scheduleSummary } from "@/lib/schedule";
import { groupSizeLabel, initialOf, shortLanguageNote } from "@/lib/card-model";
import { jaGuideLine, jaYen } from "@/lib/ja-catalog";

/** The Japanese card's extras: the people on 街の人 this experience is met through (#585), and the Japanese interface copy. */
export type SiteCardOptions = {
  readonly people?: readonly { readonly name: string; readonly photo?: { readonly src: string } }[];
  readonly copy?: StaticCopyAccessorV1;
};

function japaneseSiteCard(item: SitePublicExperience, { people = item.memberProfiles ?? [], copy }: SiteCardOptions): CardModel | null {
  if (!japaneseListPublication(item)) return null;
  const { publication, saleTerms } = item;
  const { japanese } = publication;
  const offers = saleTerms.offers;
  // The same decisions as the Japanese list's card (`jaCardOf`): the people it is met through, else the provider's public name.
  const providerName = publication.providerPublicName?.trim() || null;
  const person = publication.providerKind === "PERSON";
  const withLabel = jaGuideLine(people.map((entry) => entry.name)) ?? (providerName ? (person ? `${providerName}さんと` : `${providerName}が案内`) : publication.sellerDisplayName);
  const faceName = people[0]?.name.trim() || providerName || publication.sellerDisplayName;
  const faceUrl = people[0]?.photo?.src ?? publication.providerPhoto?.src ?? null;
  const durations = offers.map((offer) => offer.durationMinutes).sort((a, b) => a - b);
  const prices = offers.map((offer) => offer.pricing.adultPriceYen);
  const photo = publication.photos[0];
  const language = japanese.language.trim();
  return {
    slug: publication.slug,
    title: japanese.title,
    lead: japanese.lead,
    cover: photo ? { url: photo.src, alt: photo.altJa || `${japanese.title}の写真` } : null,
    withLabel,
    face: { name: faceName, initial: initialOf(faceName), image: faceUrl ? { url: faceUrl, alt: "" } : null },
    groupLabel: groupSizeLabel(offers.map((offer) => ({ capacity: offer.capacity, maxPartySize: offer.maxPartySize, minimumParticipants: offer.minimumParticipants })), "ja", copy),
    durationLabel: durations[0] === durations.at(-1) ? formatDuration(durations[0]!, "ja") : `${formatDuration(durations[0]!, "ja")}–${formatDuration(durations.at(-1)!, "ja")}`,
    language: language ? { short: language, full: language } : null,
    scheduleLabel: scheduleSummary(offers.map((offer) => ({ weekdays: [...offer.weekdays], startTime: offer.startTime })), "ja"),
    // 日本語サイトの料金は半角の ¥（一覧・詳細と同じ `jaYen`）。Intl の ja-JP は全角の ￥ を返す。
    priceLabel: Math.min(...prices) === 0 ? "無料" : jaYen(Math.min(...prices)),
    priceIsFrom: new Set(prices).size > 1,
    offers: offers.map((offer) => ({ id: offer.id, minimumParticipants: offer.minimumParticipants, maxPartySize: offer.maxPartySize })),
  };
}

/**
 * A card made only from Experience's public manuscript and sale projection. `"ja"` builds the Japanese card from the Japanese
 * manuscript (null when the product has no Japanese text or no sale); the English card is unchanged.
 */
export function sitePublicationCard(item: SitePublicExperience, locale?: "en"): CardModel;
export function sitePublicationCard(item: SitePublicExperience, locale: "ja", options?: SiteCardOptions): CardModel | null;
export function sitePublicationCard(item: SitePublicExperience, locale: "en" | "ja" = "en", options: SiteCardOptions = {}): CardModel | null {
  if (locale === "ja") return japaneseSiteCard(item, options);
  const { publication, saleTerms, sellerDisclosure } = item;
  const offers = saleTerms?.offers ?? [];
  const durations = offers.map((offer) => offer.durationMinutes).sort((a, b) => a - b);
  const weekdaysAndTimes = offers.map((offer) => ({ weekdays: [...offer.weekdays], startTime: offer.startTime }));
  const language = publication.content.facts.language.trim();
  const firstPhoto = publication.photos[0];
  const prices = offers.map((offer) => offer.pricing.adultPriceYen);
  const image = firstPhoto ? { url: firstPhoto.src, alt: firstPhoto.alt } : null;
  // The English card (the Japanese list has its own): the English public name when the provider has one (#587).
  const providerName = providerNameFor(publication, "en") ?? publication.sellerDisplayName;
  const legacyFaceMedia = sellerDisclosure?.sellerKind === "BUSINESS"
    ? publication.businessLogo
    : sellerDisclosure?.sellerKind === "PERSON" ? publication.providerPhoto : publication.providerPhoto ?? publication.businessLogo;
  const faceMedia = publication.providerPublicName
    ? publication.providerPhoto ?? (publication.providerKind === "BUSINESS" ? publication.businessLogo : null)
    : legacyFaceMedia;
  const faceImage = faceMedia ? { url: faceMedia.src, alt: faceMedia.alt } : null;
  return {
    slug: publication.slug,
    title: publication.publicTitle,
    lead: publication.content.lead,
    cover: image,
    withLabel: `with ${providerName}`,
    face: { name: providerName, initial: initialOf(providerName), image: faceImage },
    groupLabel: offers.length ? groupSizeLabel(offers.map((offer) => ({ capacity: offer.capacity, maxPartySize: offer.maxPartySize, minimumParticipants: offer.minimumParticipants }))) : null,
    durationLabel: durations.length ? durations[0] === durations.at(-1) ? formatDuration(durations[0]!, "en") : `${formatDuration(durations[0]!, "en")}–${formatDuration(durations.at(-1)!, "en")}` : "See details",
    language: language ? { short: shortLanguageNote(language), full: language } : null,
    scheduleLabel: scheduleSummary(weekdaysAndTimes),
    priceLabel: prices.length ? formatYen(Math.min(...prices), "en") : formatYen(publication.unitAmount, "en"),
    priceIsFrom: new Set(prices).size > 1,
    offers: offers.map((offer) => ({ id: offer.id, minimumParticipants: offer.minimumParticipants, maxPartySize: offer.maxPartySize })),
  };
}

/** Presentation for a sale condition in public copy; used on the native seller page and booking UI. */
export function cancellationSummary(offer: SitePublicOffer, locale: "en" | "ja" = "en"): string {
  const { cancellationPolicy, cancellationTerms } = offer;
  if (cancellationPolicy.code === "NONE") return locale === "ja" ? "キャンセル時の返金はありません" : "Non-refundable";
  if (cancellationPolicy.code === "FREE_UNTIL_24H" || cancellationPolicy.code === "FREE_UNTIL_48H") {
    return locale === "ja" ? `開始${cancellationPolicy.freeCancellationHoursBefore}時間前までキャンセル無料` : `Free cancellation until ${cancellationPolicy.freeCancellationHoursBefore} hours before the start`;
  }
  const window = cancellationTerms.cancellationWindowMinutesBeforeStart;
  const percent = cancellationTerms.refundBasisPoints / 100;
  if (window === null || percent === 0) return locale === "ja" ? "キャンセル時の返金はありません" : "No cancellation refund";
  const hours = window / 60;
  const deadline = Number.isInteger(hours) ? `${hours}${locale === "ja" ? "時間" : " hours"}` : `${window}${locale === "ja" ? "分" : " minutes"}`;
  return locale === "ja" ? `開始${deadline}前までのキャンセルで${percent}%返金` : `${percent}% refund when cancelled at least ${deadline} before the start`;
}

export function scheduleDescription(offer: SitePublicOffer, locale: "en" | "ja" = "en"): string {
  const weekdays = offer.weekdays.length === 7 ? (locale === "ja" ? "毎日" : "Every day") : offer.weekdays.map((day) => (locale === "ja" ? ["日", "月", "火", "水", "木", "金", "土"] : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"])[day]).join(" · ");
  return `${weekdays} · ${formatClock(offer.startTime, locale)} JST`;
}

/** Cancellation lines by offer: one line when every offer says the same, else each offer's own. Always the product's own terms. */
export function cancellationLines(offers: readonly SitePublicOffer[], locale: "en" | "ja" = "en"): { label: string | null; text: string }[] {
  const lines = offers.map((offer) => ({ name: offer.name, text: cancellationSummary(offer, locale) }));
  const distinct = [...new Set(lines.map((line) => line.text))];
  return distinct.length <= 1 ? distinct.map((text) => ({ label: null, text })) : lines.map((line) => ({ label: line.name, text: line.text }));
}
