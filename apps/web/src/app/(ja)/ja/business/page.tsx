import type { Metadata } from "next";
import { GroupGuidePage } from "@/components/pages/GroupGuidePage";
import { BUSINESS_GUIDE } from "@/lib/group-inquiry-guide";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: BUSINESS_GUIDE.metaTitle, description: BUSINESS_GUIDE.metaDescription };

export default function JapaneseBusinessPage() {
  return <GroupGuidePage guide={BUSINESS_GUIDE} />;
}
