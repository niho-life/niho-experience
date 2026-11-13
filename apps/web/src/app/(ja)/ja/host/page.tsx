import type { Metadata } from "next";
import { JapaneseHostPage } from "@/components/pages/JapaneseHostPage";
import { japaneseHostMetadata } from "@/components/pages/HostPageContent";

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;
export function generateMetadata(): Promise<Metadata> {
  return japaneseHostMetadata();
}

/** 体験を載せる (#565): 日本語サイトの独自の構成。英語の /host は今までどおり HostPageContent。 */
export default function JapaneseHostRoute(props: { searchParams: Promise<SearchParams> }) {
  return <JapaneseHostPage searchParams={props.searchParams} />;
}
