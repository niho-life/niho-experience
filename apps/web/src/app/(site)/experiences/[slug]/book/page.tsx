import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BookingPageContent } from "@/components/pages/BookingPageContent";
import { SitePublicationBooking } from "@/components/pages/SitePublicationBooking";
import { config } from "@/lib/config";
import { getSitePublicExperience } from "@/lib/experience/site-publications";
import type { SearchParams } from "@/lib/filters";

export const metadata: Metadata = { title: "Your booking", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";
export const revalidate = 0;

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<SearchParams> };

export default async function BookPage(props: Props) {
  const local = await getSitePublicExperience((await props.params).slug);
  if (local?.kind === "published") return <div className="container-page py-8 lg:py-12"><SitePublicationBooking item={local.item} siteOrigin={new URL(config.siteUrl).origin} consentVersion={config.guestBookingConsentVersion} bookingsEnabled={config.bookingsEnabled && config.guestBookingEnabled} /></div>;
  if (local?.kind === "reserved") notFound();
  return BookingPageContent({ ...props, locale: "en" });
}
