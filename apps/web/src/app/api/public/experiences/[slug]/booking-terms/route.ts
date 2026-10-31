import { config } from "@/lib/config";
import { publicEmpty, publicJson } from "@/lib/experience/public-http";
import { guestBookingRepository } from "@/lib/experience/store-server";
import { saleTermsOf } from "@/lib/guest-booking-source";
import type { SiteSaleTerms } from "@/lib/guest-booking-terms";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 販売条件 of an experience sold on this site (#285, docs/guest-booking.md): its offers and booking terms in the
 * shape the booking form already reads (SiteSaleTerms, the same mapping the detail page uses). The form reads
 * it again after QUESTIONS_CHANGED, PRICE_CHANGED or CONSENT_OUTDATED instead of NIHO's detail. Counted per
 * request and never cached (`no-store`). The flag off, or an experience not for sale here: 404 without a body.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }): Promise<Response> {
  if (!config.guestBookingEnabled) return publicEmpty(404);
  const { slug } = await params;
  if (slug.length < 1 || slug.length > 160) return publicEmpty(404);
  const bookings = guestBookingRepository();
  if (!bookings) return publicEmpty(503);
  try {
    const terms = await bookings.publicBookingTerms(slug);
    return terms === null ? publicEmpty(404) : publicJson(200, saleTermsOf(terms) satisfies SiteSaleTerms);
  } catch (error) {
    console.error("Experience guest booking terms failed", { error: error instanceof Error ? error.name : typeof error });
    return publicEmpty(503);
  }
}
