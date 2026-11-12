import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BookingOpen } from "@/components/BookingOpen";
import { bookingPagesEnabled } from "@/lib/experience/booking-access-http";

// Never prerendered: the flags are read per request. next.config.ts sends no-store and noindex for /bookings.
export const dynamic = "force-dynamic";

type LangQuery = { searchParams?: Promise<{ lang?: string | string[] }> };
const localeOf = async ({ searchParams }: LangQuery = {}) => ((await searchParams)?.lang === "ja" ? "ja" : "en") as "en" | "ja";

export async function generateMetadata(props: LangQuery = {}): Promise<Metadata> {
  return { title: (await localeOf(props)) === "ja" ? "ご予約を開く" : "Open your booking", robots: { index: false, follow: false }, referrer: "no-referrer" };
}

/**
 * The link in the guest's emails (#285 slice 6, docs/guest-booking.md): `/bookings/open#g=<grant>`. The server never
 * sees the grant (it is in the fragment); the page reads it in the browser and opens the booking on a button press.
 */
export default async function BookingOpenPage(props: LangQuery = {}) {
  if (!bookingPagesEnabled()) notFound();
  return <BookingOpen locale={await localeOf(props)} />;
}
