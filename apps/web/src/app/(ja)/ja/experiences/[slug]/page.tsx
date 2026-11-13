import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ExperiencePageContent, japaneseExperienceMetadata } from "@/components/pages/ExperiencePageContent";
import { SitePublicationPage, sitePublicationMetadata } from "@/components/pages/SitePublicationPage";
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
    return <SitePublicationPage item={local.item} cancelled={(await props.searchParams).checkout === "cancelled"} locale="ja" />;
  }
  return ExperiencePageContent({ ...props, locale: "ja" });
}
