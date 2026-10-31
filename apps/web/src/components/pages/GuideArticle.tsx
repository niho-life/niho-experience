import NextImage from "next/image";
import Link from "next/link";
import { GuideBody } from "@/components/GuideBody";
import { GuideExperienceCta, GuideFaq, GuideTeasers } from "@/components/GuideBlocks";
import type { CardDatesSource } from "@/components/CardDates";
import { guestBookingSources } from "@/lib/guest-booking-source";
import { JsonLd } from "@/components/JsonLd";
import { Notice } from "@/components/ui";
import { YouTubeVideo } from "@/components/YouTubeVideo";
import type { Guide } from "@/content/guides";
import { config, isPreview } from "@/lib/config";
import { cardsFor, readListedExperiences } from "@/lib/experience-cards";
import type { SearchParams } from "@/lib/filters";
import { guideLinkHref, parseGuideMarkdown } from "@/lib/guide-markdown";
import { guideCatalogForSite } from "@/lib/guide-registry";
import { formatGuideDate, guideCtaInsertAfter, guideOutline, guidePillarDetails, guideReadMinutes, listedExperienceSlugs, relatedGuidesOf } from "@/lib/guides";
import { SITE_NAME } from "@/lib/public-metadata";
import { breadcrumbJsonLd, guideArticleJsonLd } from "@/lib/structured-data";

/**
 * How a guide is shown:
 * - `published`: a listed guide (or an unlisted one by its direct URL; its metadata says noindex).
 * - `draft`: a mock-preview draft, with a notice.
 * - `editorial-preview`: a static unlisted editorial preview, with a notice and no structured data.
 * - `editor-preview`: an editor.niho.life draft at /guides/preview (#253), with a notice and no structured data.
 */
export type GuideArticleVariant = "published" | "draft" | "editorial-preview" | "editor-preview";

/**
 * One guide, fully in the server HTML: title, author, dates, hero, body, FAQ, experiences to book and related guides.
 * `/guides/{slug}` and `/guides/preview` both render through here, so a preview looks exactly like the published page.
 */
export async function GuideArticle({ guide, variant, query }: { guide: Guide; variant: GuideArticleVariant; query: SearchParams }) {
  const editorialPreview = variant === "editorial-preview";
  const structuredData = variant === "published" || variant === "draft";
  const blocks = parseGuideMarkdown(guide.body);
  const outline = guideOutline(blocks);
  const toc = outline.filter((item) => item.level === 2);
  // Related guides only: a preview stays readable while the publication list is unavailable.
  const catalog = await guideCatalogForSite();
  const related = relatedGuidesOf(catalog.guides, guide);
  // The call to action skips experiences the catalogue no longer lists, and disappears when the catalogue cannot be read.
  const listed = await readListedExperiences(query);
  const featured = listed ? listedExperienceSlugs(guide, listed).flatMap((slug) => listed.filter((item) => item.slug === slug)) : [];
  const [ctaCard, ...otherCards] = await cardsFor(featured, query);
  const cardDates: CardDatesSource = { kind: "read", preview: isPreview, sources: await guestBookingSources(featured.map((item) => item.slug)) };
  const hero = guide.hero ? { ...guide.hero, href: guideLinkHref(guide.hero.src)?.href ?? null } : null;
  const pillar = guidePillarDetails(guide.pillar);
  const sectionLabel = guide.category?.label ?? pillar?.label ?? "Draft preview";
  const publicFigures = new Map(guide.publicFigures?.map((figure) => [figure.assetId.toLowerCase(), figure]) ?? []);

  return (
    <>
      {structuredData ? <JsonLd data={guideArticleJsonLd(guide, config.siteUrl, SITE_NAME)} /> : null}
      {structuredData ? <JsonLd data={breadcrumbJsonLd(config.siteUrl, [{ name: "Home", path: "/" }, { name: "Guides", path: "/guides" }, { name: guide.title, path: `/guides/${guide.slug}` }])} /> : null}
      <article className="container-page pt-6 sm:pt-9">
        <div className="mx-auto max-w-[46rem]">
          {variant === "draft" ? (
            <div className="mb-5">
              <Notice tone="warn" title="Draft · not published · visible only in this preview" />
            </div>
          ) : null}
          {editorialPreview ? (
            <div className="mb-5">
              <Notice tone="warn" title="Editorial preview · details are being checked · anyone with this link can view it" />
            </div>
          ) : null}
          {variant === "editor-preview" ? (
            <div className="mb-5">
              <Notice tone="warn" title="Preview from editor.niho.life · not published · link expires soon" />
            </div>
          ) : null}
          <nav aria-label="Breadcrumb" className="text-sm text-muted">
            {editorialPreview ? <Link href="/" className="font-extrabold text-ink hover:underline">NIHO Experience</Link> : <Link href="/guides" className="font-extrabold text-ink hover:underline">Guides</Link>}
            <span aria-hidden> / </span>
            <span aria-current="page">{sectionLabel}</span>
          </nav>
          <header className="pt-5">
            <p className="eyebrow">{sectionLabel}</p>
            <h1 className="mt-1.5 text-[2.125rem] leading-[1.1] sm:text-[2.875rem]">{guide.title}</h1>
            <p className="mt-4 text-[0.9375rem] text-muted">
              <b className="font-extrabold text-ink">{guide.author.name}</b> · {guide.author.role ? <>{guide.author.role} · </> : null}{editorialPreview ? "Previewed" : "Published"}{" "}
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
          {/* A draft may have no lead yet; every published guide has one. */}
          {guide.description ? <p className="mt-6 text-lg leading-relaxed text-ink-soft">{guide.description}</p> : null}
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
              figureSrc={(figure) => figure.assetId ? publicFigures.get(figure.assetId.toLowerCase())?.src ?? null : null}
              figureCredit={(assetId) => publicFigures.get(assetId.toLowerCase())?.credit}
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
              <b className="font-extrabold text-ink">{guide.author.name}</b>
              {(guide.author.bio ?? guide.author.role) ? <> · {guide.author.bio ?? guide.author.role}</> : null}
            </p>
          </section>
        </div>
      </article>
    </>
  );
}
