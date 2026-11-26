import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BookingSummaryHeader } from "@/components/BookingSummaryHeader";
import { loadClassificationOf } from "@/lib/experience-categories-server";
import { loadPeople } from "@/lib/ja-people";
import { BookingPageContent } from "@/components/pages/BookingPageContent";
import { SitePublicationBooking } from "@/components/pages/SitePublicationBooking";
import { attributionEnabled } from "@/lib/attribution-enabled";
import { config } from "@/lib/config";
import { getSitePublicExperience } from "@/lib/experience/site-publications";
import type { SearchParams } from "@/lib/filters";
import { siteBookingSelectionFromSearch } from "@/lib/experience/site-booking-selection";

export const metadata: Metadata = { title: "予約", robots: { index: false, follow: false } };

export default async function JapaneseBookPage(props: { params: Promise<{ slug: string }>; searchParams: Promise<SearchParams> }) {
  if (config.apiMode === "http") {
    const local = await getSitePublicExperience((await props.params).slug, "ja");
    if (local?.kind !== "published" || !local.item.publication.japanese) notFound();
    const initialSelection = siteBookingSelectionFromSearch(await props.searchParams);
    const slug = local.item.publication.slug;
    const [classification, people] = await Promise.all([loadClassificationOf(slug), loadPeople()]);
    return <div className="container-page max-w-3xl py-8 lg:py-12"><BookingSummaryHeader item={local.item} locale="ja" area={classification?.area ?? null} people={people.filter((entry) => entry.experienceSlugs.includes(slug))} /><SitePublicationBooking item={local.item} siteOrigin={new URL(config.siteUrl).origin} consentVersion={config.guestBookingConsentVersion} bookingsEnabled={config.bookingsEnabled && config.guestBookingEnabled} locale="ja" attributionEnabled={attributionEnabled()} initialSelection={initialSelection} /></div>;
  }
  return BookingPageContent({ ...props, locale: "ja" });
}
