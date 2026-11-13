import type { FooterLinkV1 } from "@niho/experience-presentation/v1";
import { config } from "@/lib/config";

/** Whether the inquiry feature shows anywhere on the public site: its flag (the mock's preview flag only shows the form). */
export const groupInquiryOpen = (): boolean => config.groupInquiryEnabled;

/**
 * The Japanese footer's links to the inquiry form and its two guides (#532): 相談する・法人・団体の方へ・学校の方へ. Empty while
 * the flag is off. The paths are fixed here, so the footer never builds a link from anything a visitor typed.
 */
export function inquiryFooterLinks(): readonly FooterLinkV1[] {
  if (!groupInquiryOpen()) return [];
  return [
    { href: "/ja/inquiry", label: "相談する" },
    { href: "/ja/business", label: "法人・団体の方へ" },
    { href: "/ja/schools", label: "学校の方へ" },
  ];
}
