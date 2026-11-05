import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BookingPageContent } from "@/components/pages/BookingPageContent";
import { SitePublicationBooking } from "@/components/pages/SitePublicationBooking";
import { config } from "@/lib/config";
import { getSitePublicExperience } from "@/lib/experience/site-publications";
import type { SearchParams } from "@/lib/filters";

export const metadata: Metadata = { title: "予約", robots: { index: false, follow: false } };

export default async function JapaneseBookPage(props: { params: Promise<{ slug: string }>; searchParams: Promise<SearchParams> }) {
  if (config.apiMode === "http") {
    const local = await getSitePublicExperience((await props.params).slug);
    if (local?.kind !== "published" || !local.item.publication.japanese) notFound();
    return <div className="container-page py-8 lg:py-12"><SitePublicationBooking item={local.item} siteOrigin={new URL(config.siteUrl).origin} consentVersion={config.guestBookingConsentVersion} bookingsEnabled={config.bookingsEnabled && config.guestBookingEnabled} locale="ja" /></div>;
  }
  return BookingPageContent({ ...props, locale: "ja" });
}
