import "server-only";
import { guideRegistry, type Guide } from "@/content/guides";
import { isPreview } from "./config";
import { guidesForExperience, sortGuides } from "./guides";

/**
 * The guides this deployment shows (ADR 0002): the published modules, plus the synthetic samples in the mock preview.
 * With the real API and no published guide, everything here is empty: /guides answers 404, the sitemap and the footer
 * leave guides out, and experience pages show no guides block.
 */
export function availableGuides(): Guide[] {
  return sortGuides(guideRegistry(isPreview));
}

export function findGuide(slug: string): Guide | null {
  return availableGuides().find((guide) => guide.slug === slug) ?? null;
}

export function guidesAboutExperience(experienceSlug: string): Guide[] {
  return guidesForExperience(availableGuides(), experienceSlug);
}
