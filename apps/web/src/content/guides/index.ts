import { sampleDayPlan } from "./samples/day-plan";
import { sampleFirstEvening } from "./samples/first-evening";
import { sampleRainyDay } from "./samples/rainy-day";
import { kamakuraAfter4Pm } from "./kamakura-after-4-pm";
import type { Guide } from "./types";

export type { Guide, GuideAuthor, GuideFaqItem, GuideHero, GuidePillar, GuideTranslation } from "./types";

/**
 * Published guides: one module per guide in this folder, added to this list by a reviewed PR and live on the next deploy
 * (docs/content/guides.md, ADR 0002). Drafts are not committed. Unlisted editorial previews are public by direct URL
 * but stay out of the list, sitemap and footer until they are approved for discovery.
 */
export const PUBLISHED_GUIDES: readonly Guide[] = [kamakuraAfter4Pm];

/** Synthetic sample guides (`samples/`) for the mock preview only. They never appear with the real API. */
export const SAMPLE_GUIDES: readonly Guide[] = [sampleFirstEvening, sampleRainyDay, sampleDayPlan];

/** Guides exposed in navigation: listed publications, plus the samples in the mock preview. */
export function guideRegistry(preview: boolean): readonly Guide[] {
  const listed = PUBLISHED_GUIDES.filter((guide) => !guide.unlisted);
  return preview ? [...listed, ...SAMPLE_GUIDES] : listed;
}
