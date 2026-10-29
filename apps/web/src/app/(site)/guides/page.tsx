import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { GuideDraftProblems, GuideTeasers } from "@/components/GuideBlocks";
import { JsonLd } from "@/components/JsonLd";
import { config } from "@/lib/config";
import { guideCatalog, hasGuidesPage } from "@/lib/guide-registry";
import { englishAlternates } from "@/lib/locale-metadata";
import { publicMetadata } from "@/lib/public-metadata";
import { breadcrumbJsonLd } from "@/lib/structured-data";
import { GUIDE_PILLARS } from "@/lib/guides";

const GUIDES_TITLE = "Kamakura, from people who live here";
const GUIDES_DESCRIPTION = "Short, first-hand guides by our hosts. No sponsored lists, no ‘top 15’. Each one says who wrote it and when it was last checked.";

export async function generateMetadata(): Promise<Metadata> {
  if (!hasGuidesPage(await guideCatalog())) notFound();
  return { ...publicMetadata(GUIDES_TITLE, GUIDES_DESCRIPTION, `${config.siteUrl}/guides`), alternates: await englishAlternates("/guides") };
}

/**
 * The guides list. Exists only while at least one guide is available (ADR 0002); otherwise 404. In the mock preview it also
 * lists drafts (marked "Draft") and, above the list, the drafts that could not be shown, so a list of only problems stays.
 */
export default async function GuidesPage() {
  const catalog = await guideCatalog();
  if (!hasGuidesPage(catalog)) notFound();
  const unclassified = catalog.guides.filter((guide) => !guide.pillar);
  const categoriesBySlug = new Map<string, NonNullable<(typeof catalog.guides)[number]["category"]>>();
  for (const guide of catalog.guides) {
    if (guide.category && !categoriesBySlug.has(guide.category.slug)) categoriesBySlug.set(guide.category.slug, guide.category);
  }
  const categories = [...categoriesBySlug.values()]
    .sort((a, b) => a.displayOrder - b.displayOrder || a.label.localeCompare(b.label));
  return (
    <div className="container-page pt-9 sm:pt-14">
      <JsonLd data={breadcrumbJsonLd(config.siteUrl, [{ name: "Home", path: "/" }, { name: "Guides", path: "/guides" }])} />
      <header className="max-w-[46rem]">
        <p className="eyebrow">Guides</p>
        <h1 className="mt-1.5 text-[2.5rem] sm:text-[3.625rem]">{GUIDES_TITLE}</h1>
        <p className="mt-3 text-lg leading-relaxed text-ink-soft">{GUIDES_DESCRIPTION}</p>
      </header>
      {catalog.draftProblems.length ? (
        <div className="mt-8 max-w-[46rem]">
          <GuideDraftProblems problems={catalog.draftProblems} />
        </div>
      ) : null}
      <div className="mt-12 grid max-w-[46rem] gap-14">
        {catalog.source === "database" ? categories.map((category) => {
          const guides = catalog.guides.filter((guide) => guide.category?.slug === category.slug);
          return (
            <section key={category.slug} id={category.slug} aria-labelledby={`${category.slug}-heading`} className="scroll-mt-24">
              <h2 id={`${category.slug}-heading`} className="mb-5 text-[2rem] sm:text-[2.375rem]">{category.label}</h2>
              <GuideTeasers guides={guides} descriptions={false} />
            </section>
          );
        }) : GUIDE_PILLARS.map((pillar) => {
          const guides = catalog.guides.filter((guide) => guide.pillar === pillar.key);
          return guides.length ? (
            <section key={pillar.key} id={pillar.key} aria-labelledby={`${pillar.key}-heading`} className="scroll-mt-24">
              <p className="eyebrow">{pillar.label}</p>
              <h2 id={`${pillar.key}-heading`} className="mb-5 mt-1 text-[2rem] sm:text-[2.375rem]">{pillar.heading}</h2>
              <GuideTeasers guides={guides} draftSlugs={catalog.draftSlugs} descriptions={false} />
            </section>
          ) : null;
        })}
        {catalog.source === "static" && unclassified.length ? (
          <section id="draft-previews" aria-labelledby="draft-previews-heading" className="scroll-mt-24">
            <p className="eyebrow">Preview only</p>
            <h2 id="draft-previews-heading" className="mb-5 mt-1 text-[2rem] sm:text-[2.375rem]">Drafts awaiting a pillar</h2>
            <GuideTeasers guides={unclassified} draftSlugs={catalog.draftSlugs} descriptions={false} />
          </section>
        ) : null}
      </div>
    </div>
  );
}
