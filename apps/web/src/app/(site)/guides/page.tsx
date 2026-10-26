import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { GuideTeasers } from "@/components/GuideBlocks";
import { JsonLd } from "@/components/JsonLd";
import { config } from "@/lib/config";
import { availableGuides } from "@/lib/guide-registry";
import { englishAlternates } from "@/lib/locale-metadata";
import { publicMetadata } from "@/lib/public-metadata";
import { breadcrumbJsonLd } from "@/lib/structured-data";

const GUIDES_TITLE = "Kamakura Guides";
const GUIDES_DESCRIPTION = "Guides from NIHO Experience for planning your time in Kamakura with the people who live here.";

export async function generateMetadata(): Promise<Metadata> {
  if (!availableGuides().length) notFound();
  return { ...publicMetadata(GUIDES_TITLE, GUIDES_DESCRIPTION, `${config.siteUrl}/guides`), alternates: await englishAlternates("/guides") };
}

/** The guides list. Exists only while at least one guide is available (ADR 0002); otherwise 404. */
export default function GuidesPage() {
  const guides = availableGuides();
  if (!guides.length) notFound();
  return (
    <div className="container-page pt-9 sm:pt-14">
      <JsonLd data={breadcrumbJsonLd(config.siteUrl, [{ name: "Home", path: "/" }, { name: "Guides", path: "/guides" }])} />
      <header className="max-w-[46rem]">
        <p className="eyebrow">plan your visit</p>
        <h1 className="mt-1.5 text-[2.5rem] sm:text-[3.625rem]">Guides to Kamakura</h1>
        <p className="mt-3 text-lg leading-relaxed text-ink-soft">{GUIDES_DESCRIPTION}</p>
      </header>
      <div className="mt-10 max-w-[46rem]">
        <GuideTeasers guides={guides} level={2} />
      </div>
    </div>
  );
}
