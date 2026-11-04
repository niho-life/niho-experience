import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ExperiencePageContent, englishExperienceMetadata } from "@/components/pages/ExperiencePageContent";
import { SitePublicationPage, sitePublicationMetadata } from "@/components/pages/SitePublicationPage";
import { getSitePublicExperience } from "@/lib/experience/site-publications";
import type { SearchParams } from "@/lib/filters";

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<SearchParams> };

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function generateMetadata(props: Props): Promise<Metadata> {
  const local = await getSitePublicExperience((await props.params).slug);
  if (local?.kind === "published") return sitePublicationMetadata(local.item);
  if (local?.kind === "reserved") return { title: "Experience unavailable", robots: { index: false, follow: false } };
  return englishExperienceMetadata(props);
}

export default async function ExperiencePage(props: Props) {
  const local = await getSitePublicExperience((await props.params).slug);
  if (local?.kind === "published") {
    const query = await props.searchParams;
    return <SitePublicationPage item={local.item} cancelled={query.checkout === "cancelled"} />;
  }
  if (local?.kind === "reserved") notFound();
  return ExperiencePageContent({ ...props, locale: "en" });
}
