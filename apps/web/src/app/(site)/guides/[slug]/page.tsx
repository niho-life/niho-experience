import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { GuideArticle } from "@/components/pages/GuideArticle";
import { config } from "@/lib/config";
import type { SearchParams } from "@/lib/filters";
import { findGuide, missingGuideRedirect } from "@/lib/guide-registry";
import { guideAlternates, shareableGuideImage } from "@/lib/guides";
import { publicMetadata, SITE_NAME } from "@/lib/public-metadata";

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<SearchParams> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const found = await findGuide(slug);
  if (!found) {
    // The page itself redirects (an unpublished editor guide goes back to /guides); metadata never throws a redirect.
    if (await missingGuideRedirect(slug)) return { robots: { index: false, follow: false } };
    notFound();
  }
  const { guide, draft, unlisted } = found;
  const canonical = `${config.siteUrl}/guides/${guide.slug}`;
  const base = publicMetadata(guide.title, guide.description, canonical);
  // Only a hero whose rights cover sharing becomes the share image (docs/seo.md).
  const image = shareableGuideImage(guide, config.siteUrl);
  const images = image && guide.hero ? [{ url: image, width: guide.hero.width, height: guide.hero.height, alt: guide.hero.alt }] : [];
  return {
    ...base,
    // No /ja/guides route yet (#59): en and x-default only, whatever translations a guide carries.
    alternates: guideAlternates(guide, canonical, null),
    authors: [{ name: guide.author.name }],
    openGraph: {
      title: guide.title, description: guide.description, url: canonical, siteName: SITE_NAME, locale: "en_US", type: "article",
      publishedTime: guide.publishedAt, modifiedTime: guide.updatedAt, authors: [guide.author.name], images,
    },
    twitter: { card: "summary", title: guide.title, description: guide.description, images: image ? [image] : [] },
    // Drafts and direct-link editorial previews stay out of search, even if site indexing opens later.
    ...(draft || unlisted ? { robots: { index: false, follow: false } } : {}),
  };
}

/**
 * One guide (components/pages/GuideArticle.tsx). A draft (mock preview only) opens with a notice that it is not published.
 * With the editor source, a guide that is no longer (or not yet) published redirects to /guides while /guides lists any.
 */
export default async function GuidePage({ params, searchParams }: Props) {
  const { slug } = await params;
  const found = await findGuide(slug);
  if (!found) {
    const target = await missingGuideRedirect(slug);
    if (target) redirect(target);
    notFound();
  }
  const { guide, draft, editorialPreview } = found;
  return <GuideArticle guide={guide} variant={draft ? "draft" : editorialPreview ? "editorial-preview" : "published"} query={await searchParams} />;
}
