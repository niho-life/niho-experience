import type { Metadata } from "next";
import { InquiryPage } from "@/components/pages/InquiryPage";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "相談する", robots: { index: false, follow: false } };

export default async function JapaneseInquiryPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return <InquiryPage locale="ja" search={await searchParams} />;
}
