import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PreparationReview } from "@/components/preparations/PreparationReview";
import { isPreparationUiEnabled } from "@/lib/preparations/server";

export const metadata: Metadata = { title: "掲載内容の確認", robots: { index: false, follow: false }, referrer: "no-referrer" };

export default function PreparationReviewPage() {
  if (!isPreparationUiEnabled()) notFound();
  return <PreparationReview />;
}
