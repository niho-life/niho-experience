import { notFound } from "next/navigation";
import { BookingPageViewV1, EN_STATIC_COPY_V1 } from "@niho/experience-presentation/v1";
import { TrackView } from "@/components/Analytics";
import { BookingFlow } from "@/components/BookingFlow";
import { BookingSummaryCard } from "@/components/BookingParts";
import { ButtonLink, Notice } from "@/components/ui";
import { NO_JOURNEY_EXTRAS } from "@niho-experience/api-client";
import { getExperienceForSite } from "@/lib/api";
import { getJourneyExtras } from "@/lib/journey";
import { config, isPilotPreview, isPreview } from "@/lib/config";
import type { SearchParams } from "@/lib/filters";
import { browseHref, readBrowseContext } from "@/lib/browse-context";
import { shortName } from "@/lib/themes";
import { PRESENTATION_PRIMITIVES_V1 } from "@/components/PresentationV1";
import { JapaneseUnavailable } from "@/components/JapaneseUnavailable";
import { assertSameJapaneseRelease, getJapaneseCopy, getJapaneseDetail, type SiteLocale } from "@/lib/localized-content";
import type { ExperienceDetailForSite } from "@/lib/experience-types";
import { bookingSourceOf, detailForSale, guestBookingSale, japaneseBookingOpen, type GuestBookingSale } from "@/lib/guest-booking-source";

export async function BookingPageContent({ params, searchParams, locale }: { params: Promise<{ slug: string }>; searchParams: Promise<SearchParams>; locale: SiteLocale }) {
  const { slug } = await params;
  const query = await searchParams;
  let experience: ExperienceDetailForSite, copy = EN_STATIC_COPY_V1, bookingReady = true;
  // Where this experience is sold (#285): NIHO, this site (the sale comes from the experience DB), or unknown (not bookable now).
  let sale: GuestBookingSale;
  if (locale === "ja") {
    try {
      const [selected, siteCopy, selectedSale] = await Promise.all([getJapaneseDetail(slug), getJapaneseCopy(), guestBookingSale(slug)]);
      assertSameJapaneseRelease(siteCopy.releaseId, selected);
      sale = selectedSale;
      experience = selected.experience; copy = siteCopy.copy; bookingReady = japaneseBookingOpen(sale, selected);
    } catch { return <JapaneseUnavailable />; }
  } else {
    const result = await getExperienceForSite(slug, query);
    if (!result.ok) { if (result.kind === "not_found") notFound(); throw new Error("Public experience unavailable"); }
    sale = await guestBookingSale(result.data.experience.slug);
    experience = detailForSale(result.data.experience, sale);
  }
  const available = config.bookingsEnabled && experience.booking.checkoutAvailable && bookingReady;
  // Conditions, the optional mobile number and the host's name for the questions heading (src/lib/journey.ts): English mock only for now.
  const journey = locale === "en" ? await getJourneyExtras(experience.slug) : NO_JOURNEY_EXTRAS;
  // A date picked on the detail page (public schedule data only; guest details never travel in the URL).
  const browseContext = readBrowseContext(query);
  const initialDate = browseContext.date;
  const initialOfferId = typeof query.offer === "string" && experience.offers.some((offer) => offer.id === query.offer) ? query.offer : undefined;
  const panel = available
    ? <BookingFlow experience={experience} preview={isPreview} availabilityIsProvisional={isPreview && config.mockCatalog === "pilot"} bookingSource={bookingSourceOf(sale)} attributionEnabled={locale === "en" && config.publicApiVersion === "1.2"} publicApiVersion={config.publicApiVersion} journey={journey} initialOfferId={initialOfferId} initialDate={initialDate} initialAdultCount={browseContext.guests} titleAs="h1" />
    : <div className="max-w-2xl">{locale === "en" ? <TrackView event="booking_unavailable" props={{ experience: slug, error_code: "bookings_paused" }} /> : null}<BookingSummaryCard experience={experience} offer={null} titleAs="h1" /><div className="mt-6"><Notice role="alert" tone="warn" title={locale === "ja" && !bookingReady ? copy.text("booking.unavailableJa") : copy.text("booking.paused")}>{copy.text("booking.pausedBody")}</Notice></div><div className="mt-6"><ButtonLink href={`/experiences/${slug}`} variant="secondary">{copy.text("booking.back")}</ButtonLink></div></div>;
  const backLabel = shortName(experience, isPilotPreview);
  return <BookingPageViewV1 wide primitives={PRESENTATION_PRIMITIVES_V1} copy={copy} backHref={browseHref(`/experiences/${slug}`, browseContext, initialOfferId)} backLabel={backLabel} backAccessibleLabel={copy.text("booking.back")} panel={panel} />;
}
