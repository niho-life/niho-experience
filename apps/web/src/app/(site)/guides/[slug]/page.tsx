import type { Metadata } from "next";
import NextImage from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { GuideBody } from "@/components/GuideBody";
import { GuideExperienceCta, GuideFaq, GuideTeasers } from "@/components/GuideBlocks";
import type { CardDatesSource } from "@/components/CardDates";
import { JsonLd } from "@/components/JsonLd";
import { Notice } from "@/components/ui";
import { YouTubeVideo } from "@/components/YouTubeVideo";
import { config, isPreview } from "@/lib/config";
import { cardsFor, readListedExperiences } from "@/lib/experience-cards";
import type { SearchParams } from "@/lib/filters";
import { guideLinkHref, parseGuideMarkdown } from "@/lib/guide-markdown";
import { findGuide, guideCatalog } from "@/lib/guide-registry";
import { formatGuideDate, guideAlternates, guideCtaInsertAfter, guideOutline, guidePillarDetails, guideReadMinutes, listedExperienceSlugs, relatedGuidesOf, shareableGuideImage } from "@/lib/guides";
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
  const outline = guideOutline(blocks);
  const toc = outline.filter((item) => item.level === 2);
  const catalog = await guideCatalog();
  const related = relatedGuidesOf(catalog.guides, guide);
  // The call to action skips experiences the catalogue no longer lists, and disappears when the catalogue cannot be read.
  const listed = await readListedExperiences(query);
  const featured = listed ? listedExperienceSlugs(guide, listed).flatMap((slug) => listed.filter((item) => item.slug === slug)) : [];
  const [ctaCard, ...otherCards] = await cardsFor(featured, query);
  const cardDates: CardDatesSource = { kind: "read", preview: isPreview, nihoWebOrigin: config.nihoWebOrigin };
  const hero = guide.hero ? { ...guide.hero, href: guideLinkHref(guide.hero.src)?.href ?? null } : null;
  const pillar = guidePillarDetails(guide.pillar);
  const pillarLabel = pillar?.label ?? "Draft preview";

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
            <span aria-current="page">{pillarLabel}</span>
          </nav>
          <header className="pt-5">
            <p className="eyebrow">{pillarLabel}</p>
            <h1 className="mt-1.5 text-[2.125rem] leading-[1.1] sm:text-[2.875rem]">{guide.title}</h1>
            <p className="mt-4 text-[0.9375rem] text-muted">
              <b className="font-extrabold text-ink">{guide.author.name}</b> · {guide.author.role} · Published{" "}
              <time dateTime={guide.publishedAt}>{formatGuideDate(guide.publishedAt)}</time> · Updated{" "}
              <time dateTime={guide.updatedAt}>{formatGuideDate(guide.updatedAt)}</time> · {guideReadMinutes(guide)} min read
            </p>
          </header>
          {hero?.href ? (
            <figure className="mt-7">
              <NextImage src={hero.href} alt={hero.alt} width={hero.width} height={hero.height} priority unoptimized sizes="(min-width: 46rem) 736px, 100vw" className="h-auto w-full rounded-[var(--radius-card)] bg-sand" />
              {hero.caption ? <figcaption className="mt-2 text-sm text-muted">{hero.caption}</figcaption> : null}
            </figure>
          ) : null}
          {guide.video && hero?.href ? <div className="mt-7"><YouTubeVideo video={guide.video} poster={hero.href} title={guide.title} /></div> : null}
          <p className="mt-6 text-lg leading-relaxed text-ink-soft">{guide.description}</p>
          {toc.length ? (
            <nav aria-labelledby="guide-toc-heading" className="mt-7 rounded-[var(--radius-card)] border border-line bg-sand px-5 py-4 sm:px-6">
              <h2 id="guide-toc-heading" className="font-sans text-sm font-extrabold tracking-normal">In this guide</h2>
              <ol className="mt-2 grid gap-1.5 text-sm text-ink-soft">
                {toc.map((item) => <li key={item.id}><a href={`#${item.id}`} className="hover:text-ink hover:underline">{item.sectionNumber}. {item.title}</a></li>)}
              </ol>
            </nav>
          ) : null}
          <div className="pt-8">
            <GuideBody
              blocks={blocks}
              outline={outline}
              insertAfter={ctaCard ? guideCtaInsertAfter(blocks, outline) : null}
              insertion={ctaCard ? <GuideExperienceCta card={ctaCard} dates={cardDates} /> : null}
            />
          </div>
          {otherCards.length ? (
            <section aria-labelledby="guide-more-experiences-heading" className="pt-12">
              <h2 id="guide-more-experiences-heading" className="text-[1.75rem] lg:text-[2rem]">More experiences from this guide</h2>
              <ul>
                {otherCards.map((card) => <li key={card.slug}><GuideExperienceCta card={card} dates={cardDates} /></li>)}
              </ul>
            </section>
          ) : null}
          <GuideFaq title="Questions people ask" items={guide.faq} />
          {related.length ? (
            <section aria-labelledby="guide-related-heading" className="pt-14">
              <h2 id="guide-related-heading" className="mb-4 text-[1.75rem] lg:text-[2rem]">Keep planning</h2>
              <GuideTeasers guides={related} draftSlugs={catalog.draftSlugs} descriptions={false} />
            </section>
          ) : null}
          <section aria-labelledby="guide-author-heading" className="mt-14 border-t border-line pt-6">
            <h2 id="guide-author-heading" className="font-sans text-base font-extrabold tracking-normal">About the author.</h2>
            <p className="mt-2 text-[0.9375rem] leading-relaxed text-ink-soft">
              <b className="font-extrabold text-ink">{guide.author.name}</b> · {guide.author.bio ?? guide.author.role}
            </p>
          </section>
        </div>
      </article>
    </>
  );
}
