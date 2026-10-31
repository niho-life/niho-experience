import type { Metadata } from "next";
import { BookingReturn, readReturnType } from "@/components/BookingReturn";
import { config } from "@/lib/config";
import type { SearchParams } from "@/lib/filters";

export const metadata: Metadata = { title: "Check your email", robots: { index: false, follow: false } };
/** Payment returns here from NIHO and from this site's own checkout. It shows what happens next, never a booking status (src/components/BookingReturn.tsx). */
export default async function BookingReturnPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { type } = await searchParams;
  // The review step is promised only where reviews exist (the mock, until NIHO's review API: niho-coliving/niho-app#19314).
  return <BookingReturn type={readReturnType(type)} showReview={config.journeyApi === "mock"} />;
}
