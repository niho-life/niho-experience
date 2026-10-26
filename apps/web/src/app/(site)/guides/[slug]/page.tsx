import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ExperienceCard } from "@/components/ExperienceCard";
import { GuideBlocks, GUIDE_LINK_CLASS } from "@/components/guides/GuideBody";
import { GuideCard } from "@/components/guides/GuideCard";
import { JsonLd } from "@/components/JsonLd";
import { Photo } from "@/components/Photo";
import { Notice } from "@/components/ui";
import { config } from "@/lib/config";
import { guideExperienceCards } from "@/lib/guides/experience-cards";
import { formatGuideDate, relatedGuides } from "@/lib/guides/guide";
import { getGuides } from "@/lib/guides/server";
import { PILLAR_LABELS, type Guide } from "@/lib/guides/types";
import { SITE_NAME } from "@/lib/public-metadata";
import { articleJsonLd, breadcrumbJsonLd } from "@/lib/structured-data";

type Props = { params: Promise<{ slug: string }> };

/** A table of contents only when the article has enough sections to need one. */
const TOC_MIN_HEADINGS = 3;

async function readGuide(slug: string): Promise<{ guide: Guide; guides: Guide[] }> {
  const { guides } = await getGuides();
  const guide = guides.find((candidate) => candidate.slug === slug);
  if (!guide) notFound();
  return { guide, guides };
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { guide } = await readGuide((await params).slug);
  const canonical = `${config.siteUrl}/guides/${guide.slug}`;
  // No share image until approved photos exist, as on the experience pages (lib/public-metadata.ts).
  return {
    title: guide.title,
    description: guide.description,
    // No Japanese guide yet: itself and x-default only (#139; `ja` comes with #154).
    alternates: { canonical, languages: { en: canonical, "x-default": canonical } },
    openGraph: {
      type: "article",
      title: guide.title,
      description: guide.description,
      url: canonical,
      siteName: SITE_NAME,
      locale: "en_US",
      publishedTime: guide.published,
      modifiedTime: guide.updated,
      section: PILLAR_LABELS[guide.pillar],
      images: [],
    },
    twitter: { card: "summary", title: guide.title, description: guide.description, images: [] },
    ...(guide.draft ? { robots: { index: false, follow: false } } : {}),
  };
}

export default async function GuidePage({ params }: Props) {
  const { guide, guides } = await readGuide((await params).slug);
  const inline = guide.body.flatMap((block) => (block.type === "experience" ? [block.slug] : []));
  const cards = await guideExperienceCards([...new Set([...guide.experiences, ...inline])]);
  // A card already shown in the body is not repeated at the end.
  const recommended = guide.experiences.filter((slug) => !inline.includes(slug)).flatMap((slug) => cards.get(slug) ?? []);
  const related = relatedGuides(guide, guides);
  const hasFaq = guide.body.some((block) => block.type === "faq");
  const toc = guide.headings.length >= TOC_MIN_HEADINGS ? [...guide.headings, ...(hasFaq ? [{ id: "faq", text: "Questions people ask" }] : [])] : [];
  const section = PILLAR_LABELS[guide.pillar];

  return (
    <>
      <JsonLd data={breadcrumbJsonLd(config.siteUrl, [{ name: "Home", path: "/" }, { name: "Guides", path: "/guides" }, { name: guide.title, path: `/guides/${guide.slug}` }])} />
      <JsonLd data={articleJsonLd(guide, config.siteUrl, SITE_NAME, section)} />
      <div className="container-page pt-6 pb-16">
        <article className="mx-auto max-w-[46rem]">
          {guide.draft ? (
            <div className="mb-6">
              <Notice tone="warn" title="Draft · not published · visible only in this preview" />
            </div>
          ) : null}
          <nav aria-label="Breadcrumb" className="text-sm text-muted">
            <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
              <li><Link href="/" className="font-extrabold text-ink hover:underline">Home</Link></li>
              <li aria-hidden>›</li>
              <li><Link href="/guides" className="font-extrabold text-ink hover:underline">Guides</Link></li>
              <li aria-hidden>›</li>
              <li><span aria-current="page">{guide.title}</span></li>
            </ol>
          </nav>

          <header className="pt-6">
            <p className="eyebrow">{section}</p>
            <h1 className="mt-1.5 text-[2.125rem] leading-[1.1] lg:text-[3.25rem]">{guide.title}</h1>
            <p className="mt-4 text-lg leading-relaxed text-ink-soft">{guide.description}</p>
            <div className="mt-5 border-y border-line py-3.5 text-[0.9375rem] text-ink-soft">
              <p>
                By <strong className="font-extrabold text-ink">{guide.author}</strong>, {guide.authorRole}
              </p>
              <p className="mt-0.5">
                Published <time dateTime={guide.published}>{formatGuideDate(guide.published)}</time>
                {guide.updated !== guide.published ? (
                  <>
                    {" · "}Updated <time dateTime={guide.updated}>{formatGuideDate(guide.updated)}</time>
                  </>
                ) : null}
              </p>
              {guide.factsChecked ? (
                <p className="mt-0.5 text-muted">
                  Times and prices checked on <time dateTime={guide.factsChecked}>{formatGuideDate(guide.factsChecked)}</time>
                </p>
              ) : null}
            </div>
          </header>

          <figure className="mt-6">
            <Photo image={{ url: guide.hero }} alt={guide.heroAlt} aspect="aspect-[3/2]" sizes="(min-width: 48rem) 736px, 100vw" priority />
            {guide.heroCredit ? <figcaption className="mt-2 text-sm text-muted">Photo: {guide.heroCredit}</figcaption> : null}
          </figure>

          {toc.length ? (
            <nav aria-labelledby="on-this-page" className="mt-8 rounded-[var(--radius-card)] bg-sand p-5">
              <p id="on-this-page" className="font-extrabold">On this page</p>
              <ol className="mt-2.5 space-y-1.5">
                {toc.map((heading) => (
                  <li key={heading.id}>
                    <a href={`#${heading.id}`} className={GUIDE_LINK_CLASS}>{heading.text}</a>
                  </li>
                ))}
              </ol>
            </nav>
          ) : null}

          <div className="mt-2">
            <GuideBlocks blocks={guide.body} cards={cards} />
          </div>

          {recommended.length ? (
            <section aria-labelledby="experiences-in-this-guide" className="pt-14">
              <h2 id="experiences-in-this-guide" className="mb-6 text-[1.75rem] lg:text-[2rem]">Experiences in this guide</h2>
              <ul className="grid gap-x-6 gap-y-10 sm:grid-cols-2">
                {recommended.map((card) => (
                  <li key={card.slug}><ExperienceCard card={card} /></li>
                ))}
              </ul>
            </section>
          ) : null}

          {related.length ? (
            <section aria-labelledby="more-guides" className="pt-14">
              <h2 id="more-guides" className="mb-6 text-[1.75rem] lg:text-[2rem]">More guides</h2>
              <ul className="grid gap-x-6 gap-y-10 sm:grid-cols-2">
                {related.map((item) => (
                  <li key={item.slug}><GuideCard guide={item} /></li>
                ))}
              </ul>
            </section>
          ) : null}
        </article>
      </div>
    </>
  );
}
