import type { Metadata } from "next";
import { GroupGuidePage } from "@/components/pages/GroupGuidePage";
import { japanesePublicPageMetadata } from "@/lib/locale-metadata";
import { SCHOOLS_GUIDE } from "@/lib/group-inquiry-guide";

export const dynamic = "force-dynamic";

export function generateMetadata(): Promise<Metadata> {
  return japanesePublicPageMetadata("/ja/schools", SCHOOLS_GUIDE.metaTitle, SCHOOLS_GUIDE.metaDescription);
}

export default function JapaneseSchoolsPage() {
  return <GroupGuidePage guide={SCHOOLS_GUIDE} />;
}
