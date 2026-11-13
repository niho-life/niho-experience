import type { Metadata } from "next";
import { GroupGuidePage } from "@/components/pages/GroupGuidePage";
import { SCHOOLS_GUIDE } from "@/lib/group-inquiry-guide";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: SCHOOLS_GUIDE.metaTitle, description: SCHOOLS_GUIDE.metaDescription };

export default function JapaneseSchoolsPage() {
  return <GroupGuidePage guide={SCHOOLS_GUIDE} />;
}
