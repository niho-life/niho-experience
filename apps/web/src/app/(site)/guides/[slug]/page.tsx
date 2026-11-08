import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { GuideArticle } from "@/components/pages/GuideArticle";
import { config } from "@/lib/config";
import type { SearchParams } from "@/lib/filters";
import { findGuide } from "@/lib/guide-registry";
import { guideAlternates, guideSummary, shareableGuideImage } from "@/lib/guides";
import { publicMetadata, SITE_NAME } from "@/lib/public-metadata";

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<SearchParams> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const found = await findGuide(slug);
  if (!found) {
    notFound();
  }
  const { guide, draft, unlisted } = found;
  const canonical = `${config.siteUrl}/guides/${guide.slug}`;
  // The lead, or the opening of the body when the guide has no lead.
  const description = guideSummary(guide);
  const base = publicMetadata(guide.title, description, canonical);
  // Only a hero whose rights cover sharing becomes the share image (docs/seo.md).
  const image = shareableGuideImage(guide, config.siteUrl);
  const images = image && guide.hero
    ? [{ url: image, ...(guide.hero.sizeAssumed ? {} : { width: guide.hero.width, height: guide.hero.height }), alt: guide.hero.alt }]
    : [];
  return {
    ...base,
    // No /ja/guides route yet (#59): en and x-default only, whatever translations a guide carries.
    alternates: guideAlternates(guide, canonical, null),
    authors: [{ name: guide.author.name }],
    openGraph: {
      title: guide.title, description, url: canonical, siteName: SITE_NAME, locale: "en_US", type: "article",
      publishedTime: guide.publishedAt, modifiedTime: guide.updatedAt, authors: [guide.author.name], images,
    },
    twitter: { card: "summary", title: guide.title, description, images: image ? [image] : [] },
    // Drafts and direct-link editorial previews stay out of search, even if site indexing opens later.
    ...(draft || unlisted ? { robots: { index: false, follow: false } } : {}),
  };
}

/**
 * One guide (components/pages/GuideArticle.tsx). A draft (mock preview only) opens with a notice that it is not published.
 */
export default async function GuidePage({ params, searchParams }: Props) {
  const { slug } = await params;
  const found = await findGuide(slug);
  if (!found) {
    notFound();
  }
  const { guide, draft } = found;
  return <GuideArticle guide={guide} variant={draft ? "draft" : "published"} query={await searchParams} />;
}
