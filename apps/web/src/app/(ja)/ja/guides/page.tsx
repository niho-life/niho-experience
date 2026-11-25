import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { GuidesListPage, japaneseGuideCatalog } from "@/components/pages/GuidesListPage";
import { loadJapaneseGuides } from "@/lib/ja-guides";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "読みもの", description: "歩き方、時間の使い方、雨の日のこと。鎌倉の街の人に聞いて書いた読みものです。" };

export default async function JapaneseGuidesPage() {
  const guides = await loadJapaneseGuides();
  if (!guides.length) notFound();
  return <GuidesListPage catalog={japaneseGuideCatalog(guides)} locale="ja" />;
}
