import type { Metadata } from "next";
import { ExperiencePageContent, japaneseExperienceMetadata } from "@/components/pages/ExperiencePageContent";
import type { SearchParams } from "@/lib/filters";
import { japaneseExperienceAlternates } from "@/lib/locale-metadata";

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<SearchParams> };

export async function generateMetadata(props: Props): Promise<Metadata> {
  const [metadata, { slug }] = await Promise.all([japaneseExperienceMetadata(props), props.params]);
  // Only a rendered page has a canonical. Its English pair follows localized-mapping.ts, and only while the English page is published.
  const canonical = metadata.alternates?.canonical;
  if (typeof canonical !== "string") return metadata;
  return { ...metadata, alternates: await japaneseExperienceAlternates(slug, canonical) };
}

export default function JapaneseExperiencePage(props: Props) {
  return ExperiencePageContent({ ...props, locale: "ja" });
}
