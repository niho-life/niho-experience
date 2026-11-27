import { GuideDraftProblems, GuideTeasers } from "@/components/GuideBlocks";
import { JsonLd } from "@/components/JsonLd";
import type { Guide } from "@/content/guides";
import type { GuideCatalog } from "@/lib/guide-registry";
import { guideText } from "@/lib/guide-text";
import { GUIDE_PILLARS } from "@/lib/guides";
import { breadcrumbJsonLd } from "@/lib/structured-data";
import { config } from "@/lib/config";
import type { SiteLocale } from "@/lib/experience-categories";

/** Shared guide listing for `/guides` and `/ja/guides`. */
export function GuidesListPage({ catalog, locale }: { catalog: GuideCatalog; locale: SiteLocale }) {
  const text = guideText(locale);
  const prefix = locale === "ja" ? "/ja" : "";
  const unclassified = catalog.guides.filter((guide) => !guide.pillar && !guide.category);
  const categoriesBySlug = new Map<string, NonNullable<Guide["category"]>>();
  for (const guide of catalog.guides) if (guide.category && !categoriesBySlug.has(guide.category.slug)) categoriesBySlug.set(guide.category.slug, guide.category);
  const categories = [...categoriesBySlug.values()].sort((a, b) => a.displayOrder - b.displayOrder || a.label.localeCompare(b.label));

  return <div className="container-page pt-9 sm:pt-14">
    <JsonLd data={breadcrumbJsonLd(config.siteUrl, [{ name: text.breadcrumbHome, path: `${prefix}/` }, { name: text.breadcrumbGuides, path: `${prefix}/guides` }])} />
    <header className="max-w-[46rem]">
      <p className="eyebrow">{text.listEyebrow}</p>
      <h1 className="mt-1.5 text-[2.5rem] sm:text-[3.625rem]">{text.listTitle}</h1>
      <p className="mt-3 text-lg leading-relaxed text-ink-soft">{text.listDescription}</p>
    </header>
    {catalog.draftProblems.length ? <div className="mt-8 max-w-[46rem]"><GuideDraftProblems problems={catalog.draftProblems} /></div> : null}
    {!catalog.guides.length && !catalog.draftProblems.length ? <p className="mt-8 max-w-[46rem] rounded-[18px] bg-sand px-5 py-8 text-center text-ink-soft">{text.listEmpty}</p> : null}
    {catalog.guides.length ? <div className="mt-12 grid max-w-[46rem] gap-14">
      {catalog.source !== "static" ? categories.map((category) => {
        const guides = catalog.guides.filter((guide) => guide.category?.slug === category.slug);
        return <section key={category.slug} id={category.slug} aria-labelledby={`${category.slug}-heading`} className="scroll-mt-24">
          <h2 id={`${category.slug}-heading`} className="mb-5 text-[2rem] sm:text-[2.375rem]">{locale === "ja" ? category.labelJa ?? category.label : category.label}</h2>
          <GuideTeasers guides={guides} locale={locale} />
        </section>;
      }) : GUIDE_PILLARS.map((pillar) => {
        const guides = catalog.guides.filter((guide) => guide.pillar === pillar.key);
        return guides.length ? <section key={pillar.key} id={pillar.key} aria-labelledby={`${pillar.key}-heading`} className="scroll-mt-24">
          <p className="eyebrow">{pillar.label}</p>
          <h2 id={`${pillar.key}-heading`} className="mb-5 mt-1 text-[2rem] sm:text-[2.375rem]">{pillar.heading}</h2>
          <GuideTeasers guides={guides} draftSlugs={catalog.draftSlugs} locale={locale} />
        </section> : null;
      })}
      {unclassified.length ? <section id="unclassified" aria-labelledby="unclassified-heading" className="scroll-mt-24">
        <h2 id="unclassified-heading" className="mb-5 text-[2rem] sm:text-[2.375rem]">{text.unclassified}</h2>
        <GuideTeasers guides={unclassified} draftSlugs={catalog.draftSlugs} locale={locale} />
      </section> : null}
    </div> : null}
  </div>;
}

export function japaneseGuideCatalog(guides: readonly Guide[]): GuideCatalog {
  return { source: "database", guides, draftSlugs: [], draftProblems: [] };
}
