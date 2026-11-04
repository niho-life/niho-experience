import { config } from "@/lib/config";
import { publicEmpty, publicJson } from "@/lib/experience/public-http";
import { legacyRouteAllowedForSlug } from "@/lib/experience/site-publications";
import { guestBookingRepository } from "@/lib/experience/store-server";
import { projectSitePublicSaleTerms } from "@/lib/experience/site-publications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

/** The lossless public Experience sale terms, including custom cancellation and minimum-charge conditions. */
export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }): Promise<Response> {
  if (!config.guestBookingEnabled) return publicEmpty(404);
  const { slug } = await params;
  if (slug.length < 1 || slug.length > 160) return publicEmpty(404);
  if (!await legacyRouteAllowedForSlug(slug)) return publicEmpty(404);
  const bookings = guestBookingRepository();
  if (!bookings) return publicEmpty(503);
  try {
    const terms = await bookings.publicBookingTerms(slug);
    const saleTerms = projectSitePublicSaleTerms(terms);
    return saleTerms === null ? publicEmpty(404) : publicJson(200, { saleTerms });
  } catch (error) {
    console.error("Experience public sale terms failed", { error: error instanceof Error ? error.name : typeof error });
    return publicEmpty(503);
  }
}
