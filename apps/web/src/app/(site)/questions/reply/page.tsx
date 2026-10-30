import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { GuestReply } from "@/components/GuestReply";
import { config } from "@/lib/config";

// Never prerendered: the flag is read per request. next.config.ts sends no-store and noindex for this path.
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Reply to your host", robots: { index: false, follow: false }, referrer: "no-referrer" };

/**
 * The guest's reply page (#105, docs/guest-questions.md): the host's reply email links to `/questions/reply#t=<token>`.
 * The server never sees the token (it is in the fragment); the page reads it in the browser (GuestReply).
 */
export default function GuestReplyPage() {
  if (!config.guestQuestionsEnabled) notFound();
  return <GuestReply />;
}
