import "server-only";
import type { ExperienceDetailV11, ExperienceSummaryV11 } from "@niho-experience/api-client";
import type { PublicBookingTerms, PublicExperiencePublication, PublicSellerDisclosure } from "@niho-experience/experience-store";
import { experiencePublicationRepository, guestBookingRepository, providerSellerDisclosureRepository } from "./store-server";
import { config } from "@/lib/config";

type Locale = "en" | "ja";

function summaryOf(publication: PublicExperiencePublication, terms: PublicBookingTerms | null, locale: Locale, disclosure: PublicSellerDisclosure | null): ExperienceSummaryV11 {
  const durations = terms?.offers.map((offer) => offer.durationMinutes) ?? [];
  const prices = terms?.offers.map((offer) => offer.pricing.adultPriceYen) ?? [];
  const firstPhoto = publication.photos[0];
  const coverAlt = locale === "ja" ? (firstPhoto?.altJa || `${publication.japanese?.title ?? "体験"}の写真`) : firstPhoto?.alt;
  return {
    contentLanguage: locale === "ja" ? "JA" : "EN",
    cover: firstPhoto ? { url: firstPhoto.src, alt: coverAlt ?? "" } : null,
    duration: { minMinutes: durations.length ? Math.min(...durations) : 0, maxMinutes: durations.length ? Math.max(...durations) : 0 },
    lead: locale === "ja" && publication.japanese ? publication.japanese.lead : publication.content.lead,
    priceFrom: { amountYen: prices.length ? Math.min(...prices) : publication.unitAmount, taxIncluded: true, unit: "PER_ADULT" },
    provider: {
      kind: (publication.providerPublicName ? publication.providerKind : disclosure?.sellerKind) === "PERSON" ? "INDIVIDUAL" : "BUSINESS",
      name: publication.providerPublicName ?? publication.sellerDisplayName,
    },
    region: { key: "kamakura", name: "Kamakura" },
    slug: publication.slug,
    title: locale === "ja" && publication.japanese ? publication.japanese.title : publication.publicTitle,
    updatedAt: publication.publishedAtUtc,
  };
}

function detailOf(publication: PublicExperiencePublication, terms: PublicBookingTerms | null, locale: Locale, disclosure: PublicSellerDisclosure | null): ExperienceDetailV11 {
  const japanese = locale === "ja" ? publication.japanese : null;
  const content = japanese ? {
    title: japanese.title,
    lead: japanese.lead,
    description: japanese.description,
    language: japanese.language,
    highlights: japanese.highlights,
    included: japanese.included,
    notIncluded: japanese.notIncluded,
    knowBeforeYouGo: japanese.knowBeforeYouGo,
    notSuitableFor: japanese.notSuitableFor,
    timeline: japanese.timeline,
  } : {
    title: publication.publicTitle,
    lead: publication.content.lead,
    description: publication.content.description,
    language: publication.content.facts.language,
    highlights: publication.content.highlights,
    included: publication.content.included,
    notIncluded: publication.content.notIncluded,
    knowBeforeYouGo: publication.content.knowBeforeYouGo,
    notSuitableFor: publication.content.notSuitableFor,
    timeline: publication.content.timeline,
  };
  const offers = terms?.offers.map((offer) => ({
    id: offer.id,
    name: offer.name,
    shortDescription: offer.shortDescription,
    pricing: offer.pricing,
    capacity: offer.capacity,
    maxPartySize: offer.maxPartySize,
    minimumParticipants: offer.minimumParticipants,
    durationMinutes: offer.durationMinutes,
    startTime: offer.startTime,
    weekdays: [...offer.weekdays],
    cancellationPolicy: offer.cancellationPolicy.code === "CUSTOM"
      ? { code: "NONE" as const, freeCancellationHoursBefore: null }
      : offer.cancellationPolicy,
    acceptanceMode: offer.acceptanceMode,
    bookingQuestions: offer.bookingQuestions,
    bookingQuestionsFingerprint: offer.bookingQuestionsFingerprint,
    minimumChargeableParticipants: offer.minimumChargeableParticipants,
    cancellationTerms: offer.cancellationTerms,
    saleCancellation: {
      policyCode: offer.cancellationPolicy.code,
      cancellationWindowMinutesBeforeStart: offer.cancellationTerms.cancellationWindowMinutesBeforeStart,
      refundBasisPoints: offer.cancellationTerms.refundBasisPoints,
    },
  })) ?? [];
  const localizedPhoto = (photo: { readonly src: string; readonly alt: string; readonly altJa: string }) => ({
    url: photo.src,
    alt: locale === "ja" ? (photo.altJa || `${publication.japanese?.title ?? "体験"}の写真`) : photo.alt,
  });
  const photos = publication.photos.map(localizedPhoto);
  const providerPhoto = publication.providerPhoto ? localizedPhoto(publication.providerPhoto) : null;
  const businessLogo = publication.businessLogo ? localizedPhoto(publication.businessLogo) : null;
  const providerName = publication.providerPublicName ?? publication.sellerDisplayName;
  const providerKind = publication.providerPublicName ? publication.providerKind : disclosure?.sellerKind;
  const hostAvatar = providerPhoto ?? (publication.providerPublicName && providerKind === "BUSINESS" ? businessLogo : null);
  const canonicalUrl = `${config.siteUrl}${locale === "ja" ? "/ja" : ""}/experiences/${encodeURIComponent(publication.slug)}`;
  const sellerLegalUrl = disclosure?.method === "EXTERNAL"
    ? disclosure.externalUrl
    : disclosure?.method === "NATIVE" ? `${config.siteUrl}/experiences/${encodeURIComponent(publication.slug)}/seller` : "";
  return {
    booking: {
      checkoutAvailable: Boolean(terms?.offers.length && config.guestBookingEnabled),
      consentVersion: config.guestBookingConsentVersion,
      currency: "JPY",
      legalDocuments: sellerLegalUrl ? [{ kind: "COMMERCIAL_TRANSACTIONS", url: sellerLegalUrl }] : [],
      timeZone: "Asia/Tokyo",
    },
    canonicalUrl,
    contentLanguage: locale === "ja" ? "JA" : "EN",
    cover: photos[0] ?? null,
    description: content.description,
    highlights: [...content.highlights],
    hosts: publication.providerPublicName || hostAvatar ? [{ avatar: hostAvatar, bio: null, displayName: providerName }] : [],
    included: [...content.included],
    knowBeforeYouGo: [...content.knowBeforeYouGo],
    languageNote: content.language,
    lead: content.lead,
    meetingOverview: locale === "en" ? publication.meetingOverview : null,
    meetingPointDisclosure: publication.meetingPointDisclosure,
    meetingPoint: publication.meetingPointDisclosure === "PUBLIC" && locale === "en" && publication.meetingPoint
      ? { name: publication.meetingPoint.name, address: null, accessNote: null, entranceNote: null, mapUrl: null, exteriorPhotoIndex: publication.meetingPoint.exteriorPhotoIndex }
      : null,
    notIncluded: [...content.notIncluded],
    notSuitableFor: [...content.notSuitableFor],
    offers,
    photos,
    provider: {
      kind: providerKind === "PERSON" ? "INDIVIDUAL" : "BUSINESS",
      name: providerName,
      tagline: null,
      logo: !publication.providerPublicName || providerKind === "BUSINESS" ? businessLogo : null,
    },
    region: { key: "kamakura", name: "Kamakura" },
    seller: { displayName: publication.sellerDisplayName, legalNoticeUrl: sellerLegalUrl },
    slug: publication.slug,
    timeline: [...content.timeline],
    title: content.title,
    updatedAt: publication.publishedAtUtc,
  } as unknown as ExperienceDetailV11;
}

/** Experience's active publication and sale snapshot, exposed to existing page components through their read model. */
export async function getPublicationDetail(slug: string, locale: Locale = "en"): Promise<ExperienceDetailV11 | null> {
  if (!config.experiencePublicationsEnabled) return null;
  const publications = experiencePublicationRepository();
  if (!publications) throw new Error("Experience publication store unavailable");
  const publication = await publications.getPublicBySlug(slug);
  if (!publication || (locale === "ja" && !publication.japanese)) return null;
  const booking = guestBookingRepository();
  const [candidate, disclosure] = await Promise.all([
    booking ? booking.publicBookingTerms(slug) : null,
    providerSellerDisclosureRepository()?.getPublicBySlug(slug) ?? null,
  ]);
  const terms = candidate?.conditionsVersion === null ? candidate : null;
  const safeDisclosure = disclosure && (!candidate || candidate.sellerDisplayName === disclosure.sellerDisplayName) ? disclosure : null;
  return detailOf(publication, terms, locale, safeDisclosure);
}

/** The published, currently saleable product catalog. */
export async function listPublicationSummaries(region?: string, locale: Locale = "en"): Promise<ExperienceSummaryV11[]> {
  if (!config.experiencePublicationsEnabled) return [];
  if (region && region !== "kamakura") return [];
  const publications = experiencePublicationRepository();
  if (!publications) throw new Error("Experience publication store unavailable");
  const rows = await publications.listPublic();
  const booking = guestBookingRepository();
  const disclosures = providerSellerDisclosureRepository();
  const summaries = await Promise.all(rows
    .filter((publication) => locale !== "ja" || publication.japanese !== null)
    .map(async (publication) => {
      const [terms, disclosure] = await Promise.all([
        booking ? booking.publicBookingTerms(publication.slug) : null,
        publication.providerPublicName ? null : disclosures?.getPublicBySlug(publication.slug) ?? null,
      ]);
      const safeDisclosure = disclosure && terms?.sellerDisplayName === disclosure.sellerDisplayName ? disclosure : null;
      return terms?.conditionsVersion === null && terms.offers.length ? summaryOf(publication, terms, locale, safeDisclosure) : null;
    }));
  return summaries.filter((item): item is ExperienceSummaryV11 => item !== null);
}
