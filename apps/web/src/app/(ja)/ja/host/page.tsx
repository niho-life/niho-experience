import type { Metadata } from "next";
import { HostPageContent, japaneseHostMetadata } from "@/components/pages/HostPageContent";

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;
export function generateMetadata(): Promise<Metadata> {
  return japaneseHostMetadata();
}

/** 体験を載せる (#565): 英語と同じページ部品へ日本語の文言を渡す。 */
export default function JapaneseHostRoute(props: { searchParams: Promise<SearchParams> }) {
  return <HostPageContent {...props} locale="ja" />;
}
