import type { SitePublicExperience, SitePublicOffer } from "./site-publications";
import type { CardModel } from "@/lib/card-model";
import { formatDuration, formatYen } from "@/lib/format";
import { formatClock, scheduleSummary } from "@/lib/schedule";
import { groupSizeLabel, initialOf, shortLanguageNote } from "@/lib/card-model";

/** A card made only from Experience's public manuscript and sale projection. */
export function sitePublicationCard(item: SitePublicExperience): CardModel {
  const { publication, saleTerms, sellerDisclosure } = item;
  const offers = saleTerms?.offers ?? [];
  const durations = offers.map((offer) => offer.durationMinutes).sort((a, b) => a - b);
  const weekdaysAndTimes = offers.map((offer) => ({ weekdays: [...offer.weekdays], startTime: offer.startTime }));
  const language = publication.content.facts.language.trim();
  const firstPhoto = publication.photos[0];
  const prices = offers.map((offer) => offer.pricing.adultPriceYen);
  const image = firstPhoto ? { url: firstPhoto.src, alt: firstPhoto.alt } : null;
  const providerName = publication.providerPublicName ?? publication.sellerDisplayName;
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
