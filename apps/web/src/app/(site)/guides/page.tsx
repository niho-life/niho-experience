import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { GuidesListPage } from "@/components/pages/GuidesListPage";
import { config } from "@/lib/config";
import { guideCatalog, hasGuidesPage } from "@/lib/guide-registry";
import { englishAlternates } from "@/lib/locale-metadata";
import { publicMetadata } from "@/lib/public-metadata";
import { guideText } from "@/lib/guide-text";

export async function generateMetadata(): Promise<Metadata> {
  const catalog = await guideCatalog();
  if (!hasGuidesPage(catalog)) notFound();
  const text = guideText("en");
  return { ...publicMetadata(text.listTitle, text.listDescription, `${config.siteUrl}/guides`), alternates: await englishAlternates("/guides") };
}

/** The guide list, shared with the Japanese route. */
export default async function GuidesPage() {
  const catalog = await guideCatalog();
  if (!hasGuidesPage(catalog)) notFound();
  return <GuidesListPage catalog={catalog} locale="en" />;
}
