import type { Metadata } from "next";
import { BookingReturn, readReturnType } from "@/components/BookingReturn";
import { config } from "@/lib/config";
import type { SearchParams } from "@/lib/filters";

export const metadata: Metadata = { title: "予約状況", robots: { index: false, follow: false } };

/**
 * 日本語の戻りページ（#59）。英語の `/booking/return` と同じく、予約の種別（URL の固定語）と無料かどうかだけで「このあとの流れ」を
 * 言い、予約の状況は言わない。以前は申込み・お支払いの種別を見ず、どの予約にも同じ一般的な案内を出していた。
 */
export default async function JapaneseBookingReturnPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { type, payment } = await searchParams;
  return <BookingReturn type={readReturnType(type)} showReview={config.journeyApi === "mock"} freeBooking={payment === "free"} locale="ja" />;
}
