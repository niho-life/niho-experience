import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { GuideCard } from "@/components/guides/GuideCard";
import { JsonLd } from "@/components/JsonLd";
import { Notice } from "@/components/ui";
import { config } from "@/lib/config";
import { guidesByPillar } from "@/lib/guides/guide";
import { getGuides } from "@/lib/guides/server";
import { PILLAR_LABELS } from "@/lib/guides/types";
import { publicMetadata } from "@/lib/public-metadata";
import { breadcrumbJsonLd } from "@/lib/structured-data";

const TITLE = "Kamakura Guides: Evenings, Zazen, Crafts and Day Trips";
const LEAD = "Practical notes from NIHO kamakura and the hosts we work with: what to do after the temples close, how zazen works, what you make in a craft class, and how to plan the day.";
// The lead is longer than a search snippet; this is the same promise in 160 characters.
const DESCRIPTION = "Practical notes from NIHO kamakura and local hosts: what to do after the temples close, how zazen works, what you make in a craft class and how to plan the day.";

export function generateMetadata(): Metadata {
  const canonical = `${config.siteUrl}/guides`;
  // No Japanese guides yet: itself and x-default only (#139).
  return { ...publicMetadata(TITLE, DESCRIPTION, canonical), alternates: { canonical, languages: { en: canonical, "x-default": canonical } } };
}

export default async function GuidesPage() {
  const { guides, draftProblems } = await getGuides();
  // No empty index. Draft problems exist only in the mock preview, where the author needs to see them.
  if (!guides.length && !draftProblems.length) notFound();

  return (
    <>
      <JsonLd data={breadcrumbJsonLd(config.siteUrl, [{ name: "Home", path: "/" }, { name: "Guides", path: "/guides" }])} />
      <div className="container-page pt-9 pb-16 sm:pt-14">
        <header className="max-w-3xl">
          <h1 className="text-[2.5rem] sm:text-[3.625rem]">Guides to Kamakura</h1>
          <p className="mt-3 text-lg leading-relaxed text-ink-soft">{LEAD}</p>
        </header>

        {draftProblems.length ? (
          <div className="mt-8 max-w-3xl">
            <Notice tone="warn" title={`${draftProblems.length === 1 ? "1 draft" : `${draftProblems.length} drafts`} could not be shown (preview only)`}>
              <ul className="mt-1 space-y-2">
                {draftProblems.map((problem) => (
                  <li key={problem.file}>
                    <strong className="font-extrabold text-ink">{problem.file}</strong>
                    <ul className="mt-0.5 list-disc pl-5 text-sm">
                      {problem.reasons.map((reason, index) => <li key={index}>{reason}</li>)}
                    </ul>
                  </li>
                ))}
              </ul>
            </Notice>
          </div>
        ) : null}

        {guidesByPillar(guides).map(({ pillar, guides: items }) => (
          <section key={pillar} aria-labelledby={`pillar-${pillar}`} className="pt-14">
            <h2 id={`pillar-${pillar}`} className="mb-6 text-[1.75rem] lg:text-[2rem]">{PILLAR_LABELS[pillar]}</h2>
            <ul className="grid gap-x-6 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
              {items.map((guide) => (
                <li key={guide.slug}><GuideCard guide={guide} /></li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </>
  );
}
