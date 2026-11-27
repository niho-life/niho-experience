import type { Metadata } from "next";
import { GuidesListPage, japaneseGuideCatalog } from "@/components/pages/GuidesListPage";
import { loadJapaneseGuides } from "@/lib/ja-guides";

export const dynamic = "force-dynamic";

const DESCRIPTION = "歩き方、時間の使い方、雨の日のこと。鎌倉の街の人に聞いて書いた読みものです。";

export async function generateMetadata(): Promise<Metadata> {
  const guides = await loadJapaneseGuides();
  return {
    title: "読みもの",
    description: DESCRIPTION,
    ...(guides.length ? {} : { robots: { index: false, follow: false } }),
  };
}

export default async function JapaneseGuidesPage() {
  const guides = await loadJapaneseGuides();
  return <GuidesListPage catalog={japaneseGuideCatalog(guides)} locale="ja" />;
}
