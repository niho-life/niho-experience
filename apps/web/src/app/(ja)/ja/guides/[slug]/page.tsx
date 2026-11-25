import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { GuideArticle } from "@/components/pages/GuideArticle";
import { config } from "@/lib/config";
import { loadJapaneseGuide, loadJapaneseGuides } from "@/lib/ja-guides";
import { sitePublicationCard } from "@/lib/experience/site-card-model";
import { guestBookingSources } from "@/lib/guest-booking-source";
import type { CardDatesSource } from "@/components/CardDates";

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
    openGraph: { title: guide.title, description: guide.description, url: canonical, siteName: "NIHO Travel", locale: "ja_JP", type: "article", publishedTime: guide.publishedAt, modifiedTime: guide.updatedAt },
    ...(guide.unlisted ? { robots: { index: false, follow: false } } : {}),
  };
}

export default async function JapaneseGuidePage({ params }: Props) {
  const data = await loadJapaneseGuide((await params).slug);
  if (!data) notFound();
  const cards = data.experiences.flatMap((item) => {
    const card = sitePublicationCard(item, "ja");
    return card ? [card] : [];
  });
  const cardDates: CardDatesSource = { kind: "read", preview: false, sources: await guestBookingSources(cards.map((card) => card.slug)) };
  return <GuideArticle guide={data.guide} variant="published" query={{}} locale="ja" japaneseGuides={await loadJapaneseGuides()} experienceCards={cards} experienceCardDates={cardDates} />;
}
