import type { FooterLinkV1 } from "@niho/experience-presentation/v1";
import type { SiteLocale } from "./localized-content";

/** The traveler privacy notice (#285). English only: the Japanese pages link to this same page. */
export const PRIVACY_PATH = "/privacy";

/**
 * The footer's "Privacy" link, supplied by code like the other extra footer links (components/SiteChrome.tsx). The Japanese
 * footer shows 「プライバシー」 and, as the notice has no Japanese version, points to the same English page: `/privacy` is not a
 * Japanese route, so the locale-aware link leaves it as it is (lib/locale-links.ts).
 */
export function privacyFooterLink(locale: SiteLocale): FooterLinkV1 {
  return { href: PRIVACY_PATH, label: locale === "ja" ? "プライバシー" : "Privacy" };
}
