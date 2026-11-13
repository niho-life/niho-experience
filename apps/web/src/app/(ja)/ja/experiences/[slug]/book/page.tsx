import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { JaBookingSummary } from "@/components/ja/JaBookingSummary";
import { loadJaCards } from "@/lib/ja-catalog-server";
import type { JaCard } from "@/lib/ja-catalog";
import { BookingPageContent } from "@/components/pages/BookingPageContent";
import { SitePublicationBooking } from "@/components/pages/SitePublicationBooking";
import { attributionEnabled } from "@/lib/attribution-enabled";
import { config } from "@/lib/config";
import { getSitePublicExperience } from "@/lib/experience/site-publications";
import type { SearchParams } from "@/lib/filters";

export const metadata: Metadata = { title: "予約", robots: { index: false, follow: false } };

export default async function JapaneseBookPage(props: { params: Promise<{ slug: string }>; searchParams: Promise<SearchParams> }) {
  if (config.apiMode === "http") {
    const local = await getSitePublicExperience((await props.params).slug, "ja");
    if (local?.kind !== "published" || !local.item.publication.japanese) notFound();
    const card = (await loadJaCards().catch(() => [] as readonly JaCard[])).find((entry) => entry.slug === local.item.publication.slug) ?? null;
    const request = (local.item.saleTerms?.offers ?? []).some((offer) => offer.acceptanceMode === "APPROVAL");
    return <div className="container-page max-w-3xl py-8 lg:py-12"><JaBookingSummary slug={local.item.publication.slug} title={local.item.publication.japanese.title} card={card} request={request} /><SitePublicationBooking item={local.item} siteOrigin={new URL(config.siteUrl).origin} consentVersion={config.guestBookingConsentVersion} bookingsEnabled={config.bookingsEnabled && config.guestBookingEnabled} locale="ja" attributionEnabled={attributionEnabled()} /></div>;
  }
  return BookingPageContent({ ...props, locale: "ja" });
}
