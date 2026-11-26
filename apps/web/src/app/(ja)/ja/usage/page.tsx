import type { Metadata } from "next";
import { UsagePage } from "@/components/pages/UsagePage";
import { japanesePublicPageMetadata } from "@/lib/locale-metadata";
import { USAGE_PAGE } from "@/lib/ja-service-copy";

export function generateMetadata(): Promise<Metadata> {
  return japanesePublicPageMetadata("/ja/usage", USAGE_PAGE.metaTitle, USAGE_PAGE.metaDescription);
}

export default function JapaneseUsagePage() {
  return <UsagePage />;
}
