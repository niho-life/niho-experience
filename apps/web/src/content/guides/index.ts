import { sampleDayPlan } from "./samples/day-plan";
import { sampleFirstEvening } from "./samples/first-evening";
import { sampleRainyDay } from "./samples/rainy-day";
import type { Guide } from "./types";

export type { Guide, GuideAuthor, GuideFaqItem, GuideHero, GuidePillar, GuideTranslation } from "./types";

/**
 * Published guides: one module per guide in this folder, added to this list by a reviewed PR and live on the next deploy
 * (docs/content/guides.md, ADR 0002). Drafts are not committed. While this list is empty, the real site has no /guides
 * pages, no sitemap entries and no footer link.
 */
export const PUBLISHED_GUIDES: readonly Guide[] = [];

/** Synthetic sample guides (`samples/`) for the mock preview only. They never appear with the real API. */
export const SAMPLE_GUIDES: readonly Guide[] = [sampleFirstEvening, sampleRainyDay, sampleDayPlan];

/** The guides a deployment shows: the published ones, plus the samples in the mock preview. */
export function guideRegistry(preview: boolean): readonly Guide[] {
  return preview ? [...PUBLISHED_GUIDES, ...SAMPLE_GUIDES] : PUBLISHED_GUIDES;
}
