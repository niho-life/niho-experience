import type { Metadata } from "next";
import { UsagePage } from "@/components/pages/UsagePage";
import { USAGE_PAGE } from "@/lib/ja-service-copy";

export const metadata: Metadata = { title: USAGE_PAGE.metaTitle, description: USAGE_PAGE.metaDescription };

export default function JapaneseUsagePage() {
  return <UsagePage />;
}
