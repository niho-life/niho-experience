import type { Metadata } from "next";
import { InquiryPage } from "@/components/pages/InquiryPage";

export const dynamic = "force-dynamic";

/** The page carries a person's own words in the form and a context in its URL: not for search, never cached. */
export const metadata: Metadata = { title: "Talk to us", robots: { index: false, follow: false } };

export default async function EnglishInquiryPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return <InquiryPage locale="en" search={await searchParams} />;
}
