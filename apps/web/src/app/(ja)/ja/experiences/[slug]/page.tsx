import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ExperiencePageContent, japaneseExperienceMetadata } from "@/components/pages/ExperiencePageContent";
import { JaExperiencePage } from "@/components/ja/JaExperiencePage";
import { sitePublicationMetadata } from "@/components/pages/SitePublicationPage";
import { loadJaCards } from "@/lib/ja-catalog-server";
import { loadPeople } from "@/lib/ja-people";
import type { JaCard } from "@/lib/ja-catalog";
import { config } from "@/lib/config";
import { getSitePublicExperience } from "@/lib/experience/site-publications";
import type { SearchParams } from "@/lib/filters";
import { japaneseExperienceAlternates } from "@/lib/locale-metadata";
import { getPreparedJapaneseStaticRelease } from "@/lib/localized-content";

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<SearchParams> };

export async function generateMetadata(props: Props): Promise<Metadata> {
  if (config.apiMode === "http") {
    try { await getPreparedJapaneseStaticRelease(); }
    catch { return { title: "日本語版を表示できません", robots: { index: false, follow: false } }; }
    const local = await getSitePublicExperience((await props.params).slug, "ja");
    if (local?.kind !== "published" || !local.item.publication.japanese) return { title: "体験は公開されていません", robots: { index: false, follow: false } };
    return sitePublicationMetadata(local.item, "ja");
  }
  const [metadata, { slug }] = await Promise.all([japaneseExperienceMetadata(props), props.params]);
  // Only a rendered page has a canonical. Its English pair follows localized-mapping.ts, and only while the English page is published.
  const canonical = metadata.alternates?.canonical;
  if (typeof canonical !== "string") return metadata;
  return { ...metadata, alternates: await japaneseExperienceAlternates(slug, canonical) };
}

export default async function JapaneseExperiencePage(props: Props) {
  if (config.apiMode === "http") {
    const local = await getSitePublicExperience((await props.params).slug, "ja");
    if (local?.kind !== "published" || !local.item.publication.japanese) notFound();
    // 日本語独自の体験のページ (#530): not the English page in Japanese.
    const cards = await loadJaCards().catch(() => [] as readonly JaCard[]);
    const card = cards.find((entry) => entry.slug === local.item.publication.slug) ?? null;
    const category = card?.classification.category ?? null;
    const related = category ? cards.filter((entry) => entry.classification.category === category && entry.slug !== local.item.publication.slug).slice(0, 3) : [];
    // 街の人 (#564, #585): the people this experience is met through (the provider's own listing and any person linked to it).
    const guides = (await loadPeople()).filter((entry) => entry.experienceSlugs.includes(local.item.publication.slug));
    return <JaExperiencePage item={local.item} cancelled={(await props.searchParams).checkout === "cancelled"} card={card} related={related} people={guides} />;
  }
  return ExperiencePageContent({ ...props, locale: "ja" });
}
