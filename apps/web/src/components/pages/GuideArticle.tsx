import NextImage from "next/image";
import Link from "next/link";
import type { CardDatesSource } from "@/components/CardDates";
import { GuideBody } from "@/components/GuideBody";
import { GuideExperienceCta, GuideFaq, GuideTeasers } from "@/components/GuideBlocks";
import { JsonLd } from "@/components/JsonLd";
import { Notice } from "@/components/ui";
import { YouTubeVideo } from "@/components/YouTubeVideo";
import type { Guide } from "@/content/guides";
import { config, isPreview } from "@/lib/config";
import type { CardModel } from "@/lib/card-model";
import type { SiteLocale } from "@/lib/experience-categories";
import { guestBookingSources } from "@/lib/guest-booking-source";
import { cardsFor, readListedExperiences } from "@/lib/experience-cards";
import { guideText } from "@/lib/guide-text";
import { guideLinkHref, parseGuideMarkdown } from "@/lib/guide-markdown";
import { guideCatalogForSite } from "@/lib/guide-registry";
import { formatGuideDate, guideCtaInsertAfter, guideOutline, guidePillarDetails, guideReadMinutes, listedExperienceSlugs, relatedGuidesOf } from "@/lib/guides";
import { inquiryHref } from "@/lib/group-inquiry-entry";
import { SITE_NAME } from "@/lib/public-metadata";
import { breadcrumbJsonLd, guideArticleJsonLd } from "@/lib/structured-data";

/** A published article or a mock preview draft, rendered by the same component in both languages. */
export type GuideArticleVariant = "published" | "draft";

export async function GuideArticle({
  guide,
  variant,
  query,
  locale = "en",
  japaneseGuides,
  experienceCards,
  experienceCardDates,
}: {
  guide: Guide;
  variant: GuideArticleVariant;
  query: Record<string, string | string[] | undefined>;
  locale?: SiteLocale;
  /** Japanese articles are a separate catalog; the route supplies that catalog and its native sale cards. */
  japaneseGuides?: readonly Guide[];
  experienceCards?: readonly CardModel[];
  experienceCardDates?: CardDatesSource;
}) {
  const text = guideText(locale);
  const prefix = locale === "ja" ? "/ja" : "";
  const structuredData = variant === "published" || variant === "draft";
  const blocks = parseGuideMarkdown(guide.body);
  const outline = guideOutline(blocks);
  const toc = outline.filter((item) => item.level === 2);
  const catalog = locale === "en" ? await guideCatalogForSite() : { guides: japaneseGuides ?? [], draftSlugs: [] as readonly string[] };
  const related = relatedGuidesOf(catalog.guides, guide);
  let ctaCard: CardModel | undefined;
  let otherCards: CardModel[] = [];
  let fallbackDates: CardDatesSource;
  if (locale === "en") {
    const listed = await readListedExperiences(query);
    const featured = listed ? listedExperienceSlugs(guide, listed).flatMap((slug) => listed.filter((item) => item.slug === slug)) : [];
    [ctaCard, ...otherCards] = await cardsFor(featured, query);
    fallbackDates = { kind: "read", preview: isPreview, sources: await guestBookingSources(featured.map((item) => item.slug)) };
  } else {
    [ctaCard, ...otherCards] = [...(experienceCards ?? [])];
    fallbackDates = experienceCardDates ?? { kind: "read", preview: false, sources: await guestBookingSources([...(experienceCards ?? [])].map((item) => item.slug)) };
  }
  const cardDates = experienceCardDates ?? fallbackDates;
  const inlineCta = locale === "en" && ctaCard ? guideCtaInsertAfter(blocks, outline) : null;
  const sectionCards = locale === "ja" ? [...(ctaCard ? [ctaCard] : []), ...otherCards] : otherCards;
  const shownExperiences = [...(ctaCard && inlineCta !== null && locale === "en" ? [ctaCard] : []), ...sectionCards]
    .map((card) => ({ slug: card.slug, name: card.title }));
  const hero = guide.hero ? { ...guide.hero, href: guideLinkHref(guide.hero.src)?.href ?? null } : null;
  const pillar = guidePillarDetails(guide.pillar);
  const sectionLabel = guide.category ? (locale === "ja" ? guide.category.labelJa ?? guide.category.label : guide.category.label) : pillar?.label ?? text.draftPreview;
  const publicFigures = new Map(guide.publicFigures?.map((figure) => [figure.assetId.toLowerCase(), figure]) ?? []);
  const articlePath = `${prefix}/guides/${guide.slug}`;
  const guideListPath = `${prefix}/guides`;
  const publishedDate = guide.publishedAt;
  const cardCta = (card: CardModel) => <GuideExperienceCta key={card.slug} card={card} dates={cardDates} locale={locale} />;

  return <>
    {structuredData ? <JsonLd data={guideArticleJsonLd(guide, config.siteUrl, SITE_NAME, shownExperiences, locale)} /> : null}
    {structuredData ? <JsonLd data={breadcrumbJsonLd(config.siteUrl, [{ name: text.breadcrumbHome, path: `${prefix}/` }, { name: text.breadcrumbGuides, path: guideListPath }, { name: guide.title, path: articlePath }])} /> : null}
    <article className="container-page pt-6 sm:pt-9">
      <div className="mx-auto max-w-[46rem]">
        {variant === "draft" ? <div className="mb-5"><Notice tone="warn" title={text.draftNotice} /></div> : null}
        <nav aria-label={locale === "ja" ? "パンくずリスト" : "Breadcrumb"} className="text-sm text-muted">
          <Link href={guide.unlisted ? `${prefix}/` : guideListPath} className="font-extrabold text-ink hover:underline">{guide.unlisted ? SITE_NAME : text.breadcrumbGuides}</Link>
          <span aria-hidden> / </span><span aria-current="page">{sectionLabel}</span>
        </nav>
        <header className="pt-5">
          <p className="eyebrow">{sectionLabel}</p>
          <h1 className="mt-1.5 text-[2.125rem] leading-[1.1] sm:text-[2.875rem]">{guide.title}</h1>
          <p className="mt-4 text-[0.9375rem] text-muted">
            <b className="font-extrabold text-ink">{guide.author.name}</b>{guide.author.role ? locale === "ja" ? `（${guide.author.role}）` : ` · ${guide.author.role}` : ""}{locale === "ja" ? "・" : " · "}{text.published}{" "}
            <time dateTime={publishedDate}>{formatGuideDate(publishedDate, locale)}</time>{guide.updatedAt !== guide.publishedAt ? <>{locale === "ja" ? "・" : " · "}{text.updated}{" "}<time dateTime={guide.updatedAt}>{formatGuideDate(guide.updatedAt, locale)}</time></> : null}{locale === "ja" ? "・" : " · "}{text.readTime(guideReadMinutes(guide))}
          </p>
        </header>
        {hero?.href ? <figure className="mt-7">
          <NextImage src={hero.href} alt={hero.alt} width={hero.width} height={hero.height} priority unoptimized sizes="(min-width: 46rem) 736px, 100vw" className="h-auto w-full rounded-[var(--radius-card)] bg-sand" />
          {hero.caption ? <figcaption className="mt-2 text-sm text-muted">{hero.caption}</figcaption> : null}
        </figure> : null}
        {guide.video && hero?.href ? <div className="mt-7"><YouTubeVideo video={guide.video} poster={hero.href} title={guide.title} /></div> : null}
        {guide.description ? <p className="mt-6 text-lg leading-relaxed text-ink-soft">{guide.description}</p> : null}
        {toc.length ? <nav aria-labelledby="guide-toc-heading" className="mt-7 rounded-[var(--radius-card)] border border-line bg-sand px-5 py-4 sm:px-6">
          <h2 id="guide-toc-heading" className="font-sans text-sm font-extrabold tracking-normal">{text.inThisGuide}</h2>
          <ol className="mt-2 grid gap-1.5 text-sm text-ink-soft">
            {toc.map((item) => <li key={item.id}><a href={`#${item.id}`} className="hover:text-ink hover:underline">{item.sectionNumber}. {item.title}</a></li>)}
          </ol>
        </nav> : null}
        <div className="pt-8">
          <GuideBody blocks={blocks} outline={outline} insertAfter={inlineCta} insertion={ctaCard ? <GuideExperienceCta card={ctaCard} dates={cardDates} locale={locale} /> : null}
            figureSrc={(figure) => figure.assetId ? publicFigures.get(figure.assetId.toLowerCase())?.src ?? null : null}
            figureCredit={(assetId) => publicFigures.get(assetId.toLowerCase())?.credit} />
        </div>
        {sectionCards.length ? <section aria-labelledby="guide-more-experiences-heading" className="pt-12">
          <p className="hand text-[1.25rem] text-moss">{locale === "ja" ? "go with someone" : "plan a day here"}</p>
          <h2 id="guide-more-experiences-heading" className="text-[1.75rem] lg:text-[2rem]">{text.moreExperiences}</h2>
          <ul>{sectionCards.map((card) => <li key={card.slug}>{cardCta(card)}</li>)}</ul>
        </section> : null}
        <GuideFaq title={text.questions} items={guide.faq} />
        {locale === "ja" && config.groupInquiryEnabled ? <section aria-labelledby="guide-related-inquiry" className="mt-12 rounded-[22px] bg-leaf-pale px-6 py-8">
          <h2 id="guide-related-inquiry" className="text-[1.375rem]">この記事のことで、相談したいときは</h2>
          <p className="mt-2 text-ink-soft">体験を選び切れなくても、日にちが決まっていなくても大丈夫です。はじめの相談は無料です。</p>
          <Link href={inquiryHref("ja")} className="link-leaf mt-5 inline-block font-extrabold">相談する</Link>
        </section> : null}
        {related.length ? <section aria-labelledby="guide-related-heading" className="pt-14">
          <h2 id="guide-related-heading" className="mb-4 text-[1.75rem] lg:text-[2rem]">{text.keepPlanning}</h2>
          <GuideTeasers guides={related} draftSlugs={catalog.draftSlugs} descriptions={false} locale={locale} />
        </section> : null}
        <section aria-labelledby="guide-author-heading" className="mt-14 border-t border-line pt-6">
          <h2 id="guide-author-heading" className="font-sans text-base font-extrabold tracking-normal">{text.articleAboutAuthor}</h2>
          <p className="mt-2 text-[0.9375rem] leading-relaxed text-ink-soft">
            <b className="font-extrabold text-ink">{guide.author.name}</b>{(guide.author.bio ?? guide.author.role) ? <>{locale === "ja" ? "・" : " · "}{guide.author.bio ?? guide.author.role}</> : null}
          </p>
        </section>
      </div>
    </article>
  </>;
}
