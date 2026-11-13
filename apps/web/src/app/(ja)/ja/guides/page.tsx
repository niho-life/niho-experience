import type { Metadata } from "next";
import { JapaneseGuidesListPage } from "@/components/pages/JapaneseGuidePages";
import { loadJapaneseGuides } from "@/lib/ja-guides";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "読みもの", description: "歩き方、時間の使い方、雨の日のこと。鎌倉の街の人に聞いて書いた読みものです。" };

export default async function JapaneseGuidesPage() {
  return <JapaneseGuidesListPage guides={await loadJapaneseGuides()} />;
}
