import { sampleDayPlan } from "./samples/day-plan";
import { sampleFirstEvening } from "./samples/first-evening";
import { sampleRainyDay } from "./samples/rainy-day";
import type { Guide } from "./types";

export type { Guide, GuideAuthor, GuideCategory, GuideFaqItem, GuideHero, GuidePillar, GuidePublicFigure, GuideTranslation } from "./types";

/**
 * HTTP/static is an empty rollback source after the Experience DB cutover. Real legacy modules stay in this folder only
 * as inputs to private ops imports; adding one here would expose it through list, direct, home and sitemap routes.
 */
export const PUBLISHED_GUIDES: readonly Guide[] = [];

/** Synthetic sample guides (`samples/`) for the mock preview only. They never appear with the real API. */
export const SAMPLE_GUIDES: readonly Guide[] = [sampleFirstEvening, sampleRainyDay, sampleDayPlan];

/** Guides exposed in navigation: listed publications, plus the samples in the mock preview. */
export function guideRegistry(preview: boolean): readonly Guide[] {
  const listed = PUBLISHED_GUIDES.filter((guide) => !guide.unlisted);
  return preview ? [...listed, ...SAMPLE_GUIDES] : listed;
}
