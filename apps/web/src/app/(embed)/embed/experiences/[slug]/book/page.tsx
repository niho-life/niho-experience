import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { EmbedBookingUnavailable, SitePublicationBooking } from "@/components/pages/SitePublicationBooking";
import { attributionEnabled } from "@/lib/attribution-enabled";
import { SAFE_UTM_VALUE, type BookingAttribution } from "@/lib/booking-attribution";
import { config } from "@/lib/config";
import { getSitePublicExperience } from "@/lib/experience/site-publications";
import type { SearchParams } from "@/lib/filters";
import { PROVIDER_LINK_SOURCE } from "@/lib/provider-booking-link";

export const metadata: Metadata = { title: "Book", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";
export const revalidate = 0;

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<SearchParams> };

const UTM_FIELDS = [["utm_source", "utmSource"], ["utm_medium", "utmMedium"], ["utm_campaign", "utmCampaign"], ["utm_content", "utmContent"]] as const;

/**
 * The widget's 流入の印 (docs/embed.md「流入の印」): the frame URL's own utm_* when well formed, else the provider's mark
 * with `utm_medium=embed` (the same family as the provider booking link, #531). The form drops it under Do Not Track.
 */
function embedAttribution(searchParams: SearchParams): BookingAttribution {
  const attribution: BookingAttribution = { utmSource: PROVIDER_LINK_SOURCE, utmMedium: "embed" };
  for (const [param, field] of UTM_FIELDS) {
    const value = searchParams[param];
    if (typeof value === "string" && SAFE_UTM_VALUE.test(value)) attribution[field] = value;
  }
  return attribution;
}

/** The booking widget (#638). Inside another site's frame it never shows a 404 or an error page: only "unavailable". */
export default async function EmbedBookPage(props: Props) {
  if (!config.embedEnabled) notFound();
  const siteOrigin = new URL(config.siteUrl).origin;
  const [{ slug }, searchParams] = await Promise.all([props.params, props.searchParams]);
  const local = await getSitePublicExperience(slug).catch(() => null);
  if (local?.kind !== "published") return <EmbedBookingUnavailable siteOrigin={siteOrigin} />;
  return <SitePublicationBooking
    layout="embed"
    item={local.item}
    siteOrigin={siteOrigin}
    consentVersion={config.guestBookingConsentVersion}
    bookingsEnabled={config.bookingsEnabled && config.guestBookingEnabled}
    attributionEnabled={attributionEnabled()}
    preview={searchParams.preview === "1"}
    defaultAttribution={embedAttribution(searchParams)}
  />;
}
