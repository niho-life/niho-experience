import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { FindBookingForm } from "@/components/FindBookingForm";
import { bookingPagesEnabled } from "@/lib/experience/booking-access-http";

// Never prerendered: the flags are read per request. next.config.ts sends no-store and noindex for /bookings.
export const dynamic = "force-dynamic";

export async function generateMetadata(props: LangQuery = {}): Promise<Metadata> {
  return { title: (await localeOf(props)) === "ja" ? "ご予約の確認" : "Find your booking", robots: { index: false, follow: false }, referrer: "no-referrer" };
}

/** `?lang=ja` (the link in a Japanese booking's email) makes the pages that know no booking yet speak Japanese (#59). */
type LangQuery = { searchParams?: Promise<{ lang?: string | string[] }> };
const localeOf = async ({ searchParams }: LangQuery = {}) => ((await searchParams)?.lang === "ja" ? "ja" : "en") as "en" | "ja";


/**
 * "Find your booking" (#285 slice 6, docs/guest-booking.md): there are no traveler accounts and no list of bookings.
 * The guest gets a new link to each booking by email; the page says the same whatever the address.
 */
export default async function FindBookingPage(props: LangQuery = {}) {
  if (!bookingPagesEnabled()) notFound();
  const locale = await localeOf(props);
  const ja = locale === "ja";
  return (
    <div className="container-page max-w-2xl py-12" lang={ja ? "ja" : undefined}>
      <p className="hand text-[1.75rem]">{ja ? "ご予約" : "your booking"}</p>
      <h1 className="mt-1 text-3xl">{ja ? "ご予約を確認する" : "Find your booking"}</h1>
      <p className="mt-3 text-ink-soft">
        {ja
          ? "お申込みのメールアドレスを入力してください。このサイトでのご予約ごとに、確認用のリンクをメールでお送りします。リンクは1回だけ、開いた端末でご予約を開けます。"
          : <>Enter the email address you booked with. We&apos;ll email you a link to each booking you made on this site. Each link opens the booking once, on the device you open it on.</>}
      </p>
      <FindBookingForm locale={locale} />
    </div>
  );
}
