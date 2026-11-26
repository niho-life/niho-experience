import type { Metadata } from "next";
import { GroupGuidePage } from "@/components/pages/GroupGuidePage";
import { japanesePublicPageMetadata } from "@/lib/locale-metadata";
import { BUSINESS_GUIDE } from "@/lib/group-inquiry-guide";

export const dynamic = "force-dynamic";

export function generateMetadata(): Promise<Metadata> {
  return japanesePublicPageMetadata("/ja/business", BUSINESS_GUIDE.metaTitle, BUSINESS_GUIDE.metaDescription);
}

export default function JapaneseBusinessPage() {
  return <GroupGuidePage guide={BUSINESS_GUIDE} />;
}
