import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { JapaneseGuideArticlePage } from "@/components/pages/JapaneseGuidePages";
import { config } from "@/lib/config";
import { loadJapaneseGuide } from "@/lib/ja-guides";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const data = await loadJapaneseGuide((await params).slug);
  if (!data) return { title: "読みもの", robots: { index: false, follow: false } };
  const { guide } = data;
  const canonical = `${config.siteUrl}/ja/guides/${guide.slug}`;
  return {
    title: guide.title,
    description: guide.description,
    alternates: { canonical },
    authors: [{ name: guide.author.name }],
    openGraph: { title: guide.title, description: guide.description, url: canonical, siteName: "NIHO Experience", locale: "ja_JP", type: "article", publishedTime: guide.publishedAt, modifiedTime: guide.updatedAt },
    ...(guide.unlisted ? { robots: { index: false, follow: false } } : {}),
  };
}

export default async function JapaneseGuidePage({ params }: Props) {
  const data = await loadJapaneseGuide((await params).slug);
  if (!data) notFound();
  return <JapaneseGuideArticlePage guide={data.guide} experiences={data.experiences} />;
}
