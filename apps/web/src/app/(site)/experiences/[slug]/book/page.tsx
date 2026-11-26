import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BookingSummaryHeader } from "@/components/BookingSummaryHeader";
import { BookingPageContent } from "@/components/pages/BookingPageContent";
import { SitePublicationBooking } from "@/components/pages/SitePublicationBooking";
import { attributionEnabled } from "@/lib/attribution-enabled";
import { loadClassificationOf } from "@/lib/experience-categories-server";
import { config } from "@/lib/config";
import { getSitePublicExperience } from "@/lib/experience/site-publications";
import type { SearchParams } from "@/lib/filters";
import { siteBookingSelectionFromSearch } from "@/lib/experience/site-booking-selection";

export const metadata: Metadata = { title: "Your booking", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";
export const revalidate = 0;

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<SearchParams> };

export default async function BookPage(props: Props) {
  const local = await getSitePublicExperience((await props.params).slug);
  if (local?.kind === "published") {
    const initialSelection = siteBookingSelectionFromSearch(await props.searchParams);
    const classification = await loadClassificationOf(local.item.publication.slug);
    return <div className="container-page max-w-3xl py-8 lg:py-12"><BookingSummaryHeader item={local.item} locale="en" area={classification?.area ?? null} /><SitePublicationBooking item={local.item} siteOrigin={new URL(config.siteUrl).origin} consentVersion={config.guestBookingConsentVersion} bookingsEnabled={config.bookingsEnabled && config.guestBookingEnabled} attributionEnabled={attributionEnabled()} initialSelection={initialSelection} /></div>;
  }
  if (local?.kind === "reserved") notFound();
  return BookingPageContent({ ...props, locale: "en" });
}
