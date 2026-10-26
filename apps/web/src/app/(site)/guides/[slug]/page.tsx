import type { Metadata } from "next";
import NextImage from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { GuideBody } from "@/components/GuideBody";
import { ExperienceCardGrid, GuideFaq, GuideTeasers } from "@/components/GuideBlocks";
import { JsonLd } from "@/components/JsonLd";
import { Notice } from "@/components/ui";
import { config } from "@/lib/config";
import { cardsFor, readListedExperiences } from "@/lib/experience-cards";
import type { SearchParams } from "@/lib/filters";
import { guideLinkHref, parseGuideMarkdown } from "@/lib/guide-markdown";
import { findGuide, guideCatalog } from "@/lib/guide-registry";
import { formatGuideDate, guideAlternates, listedExperienceSlugs, relatedGuidesOf, shareableGuideImage } from "@/lib/guides";
import { publicMetadata, SITE_NAME } from "@/lib/public-metadata";
import { breadcrumbJsonLd, guideArticleJsonLd } from "@/lib/structured-data";

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<SearchParams> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const found = await findGuide((await params).slug);
  if (!found) notFound();
  const { guide, draft } = found;
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
    // A draft (mock preview only) is never indexed, whatever the deployment's indexing setting.
    ...(draft ? { robots: { index: false, follow: false } } : {}),
  };
}

/**
 * One guide, fully in the server HTML: title, author, dates, hero, body, FAQ, experiences to book and related guides.
 * A draft (mock preview only) opens with a notice that it is not published.
 */
export default async function GuidePage({ params, searchParams }: Props) {
  const found = await findGuide((await params).slug);
  if (!found) notFound();
  const { guide, draft } = found;
  const query = await searchParams;
  const blocks = parseGuideMarkdown(guide.body);
  const catalog = await guideCatalog();
  const related = relatedGuidesOf(catalog.guides, guide);
  // The call to action skips experiences the catalogue no longer lists, and disappears when the catalogue cannot be read.
  const listed = await readListedExperiences(query);
  const featured = listed ? listedExperienceSlugs(guide, listed).flatMap((slug) => listed.filter((item) => item.slug === slug)) : [];
  const cards = await cardsFor(featured, query);
  const hero = guide.hero ? { ...guide.hero, href: guideLinkHref(guide.hero.src)?.href ?? null } : null;

  return (
    <>
      <JsonLd data={guideArticleJsonLd(guide, config.siteUrl, SITE_NAME)} />
      <JsonLd data={breadcrumbJsonLd(config.siteUrl, [{ name: "Home", path: "/" }, { name: "Guides", path: "/guides" }, { name: guide.title, path: `/guides/${guide.slug}` }])} />
      <article className="container-page pt-6 sm:pt-9">
        <div className="mx-auto max-w-[46rem]">
          {draft ? (
            <div className="mb-5">
              <Notice tone="warn" title="Draft · not published · visible only in this preview" />
            </div>
          ) : null}
          <nav aria-label="Breadcrumb" className="text-sm text-muted">
            <Link href="/guides" className="font-extrabold text-ink hover:underline">
              Guides
            </Link>
            <span aria-hidden> / </span>
            <span aria-current="page">{guide.title}</span>
          </nav>
          <header className="pt-5">
            <p className="eyebrow">a guide to Kamakura</p>
            <h1 className="mt-1.5 text-[2.125rem] leading-[1.1] sm:text-[2.875rem]">{guide.title}</h1>
            <p className="mt-4 text-lg leading-relaxed text-ink-soft">{guide.description}</p>
            <div className="mt-5 border-y border-line py-4 text-[0.9375rem]">
              <p>
                By <b className="font-extrabold text-ink">{guide.author.name}</b>
                <span className="text-ink-soft"> · {guide.author.role}</span>
              </p>
              <p className="mt-1 text-muted">
                Published <time dateTime={guide.publishedAt}>{formatGuideDate(guide.publishedAt)}</time> · Updated{" "}
                <time dateTime={guide.updatedAt}>{formatGuideDate(guide.updatedAt)}</time>
              </p>
            </div>
          </header>
          {hero?.href ? (
            <figure className="mt-7">
              <NextImage src={hero.href} alt={hero.alt} width={hero.width} height={hero.height} priority unoptimized sizes="(min-width: 46rem) 736px, 100vw" className="h-auto w-full rounded-[var(--radius-card)] bg-sand" />
            </figure>
          ) : null}
          <div className="pt-8">
            <GuideBody blocks={blocks} />
          </div>
          <GuideFaq title="Frequently asked questions" items={guide.faq} />
        </div>
      </article>
      {cards.length ? (
        <section aria-labelledby="guide-experiences-heading" className="container-page pt-16">
          <h2 id="guide-experiences-heading" className="mb-6 text-[1.75rem] lg:text-[2rem]">
            Book an experience from this guide
          </h2>
          <ExperienceCardGrid cards={cards} />
        </section>
      ) : null}
      {related.length ? (
        <section aria-labelledby="guide-related-heading" className="container-page pt-16">
          <div className="mx-auto max-w-[46rem]">
            <h2 id="guide-related-heading" className="mb-4 text-[1.75rem] lg:text-[2rem]">
              More guides
            </h2>
            <GuideTeasers guides={related} draftSlugs={catalog.draftSlugs} />
          </div>
        </section>
      ) : null}
    </>
  );
}
