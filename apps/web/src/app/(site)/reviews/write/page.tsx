import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { GUEST_REVIEW_TAGS } from "@niho-experience/experience-store";
import { GuestReviewWrite } from "@/components/GuestReviewWrite";
import { reviewWritingEnabled } from "@/lib/experience/guest-review-http";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Write your review", robots: { index: false, follow: false }, referrer: "no-referrer" };

export default function ReviewWritePage() {
  if (!reviewWritingEnabled()) notFound();
  return <GuestReviewWrite tags={GUEST_REVIEW_TAGS} />;
}
