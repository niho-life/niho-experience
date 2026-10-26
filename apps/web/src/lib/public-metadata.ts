import type { Metadata } from "next";
import { EN_STATIC_COPY_V1 } from "@niho/experience-presentation/v1";

export const SITE_NAME = "NIHO Experience";
export const SITE_DESCRIPTION = "Discover small experiences in Kamakura, offered by independent hosts and local businesses. Book as a guest, no account needed.";
// Decided in docs/growth/seo-content-policy.md and kept in the shared copy registry.
export const EXPERIENCE_LIST_TITLE = EN_STATIC_COPY_V1.text("catalogue.metaTitle");
export const EXPERIENCE_LIST_DESCRIPTION = EN_STATIC_COPY_V1.text("catalogue.metaDescription");

/** No share image until the public contract includes approval for that use. */
export function publicMetadata(title: string, description: string, canonical: string): Metadata {
  return {
    title, description, alternates: { canonical },
    openGraph: { title, description, url: canonical, siteName: SITE_NAME, type: "website", locale: "en_US", images: [] },
    twitter: { card: "summary", title, description, images: [] },
  };
}
