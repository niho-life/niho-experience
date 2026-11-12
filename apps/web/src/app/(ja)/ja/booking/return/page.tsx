import type { Metadata } from "next";
import { ButtonLink, Notice } from "@/components/ui";
import { JapaneseUnavailable } from "@/components/JapaneseUnavailable";
import { readReturnType } from "@/components/BookingReturn";
import type { SearchParams } from "@/lib/filters";
import { getJapaneseCopy } from "@/lib/localized-content";

export const metadata: Metadata = { title: "予約状況", robots: { index: false, follow: false } };

export default async function JapaneseBookingReturnPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { type } = await searchParams;
  const approval = readReturnType(type) === "approval";
  let copy;
  try {
    copy = (await getJapaneseCopy()).copy;
  } catch { return <JapaneseUnavailable />; }
  return <div className="container-page max-w-2xl py-12"><h1 className="text-3xl">{approval ? "申込を受け付けました" : copy.text("return.title")}</h1><div className="mt-5"><Notice tone="info" title={approval ? "事務局からの返信をお待ちください" : copy.text("return.heading")}>{approval ? "カード情報は入力されておらず、まだ決済も予約確定もしていません。承認された場合は、事務局が有効期限付きのStripe支払URLをお送りします。" : copy.text("return.body")}</Notice></div><div className="mt-6 flex flex-wrap gap-3"><ButtonLink href="/help">{copy.text("return.help")}</ButtonLink><ButtonLink href="/experiences" variant="secondary">{copy.text("return.browse")}</ButtonLink></div></div>;
}
