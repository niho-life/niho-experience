import "server-only";
import { cache } from "react";
import { guideRegistry, type Guide } from "@/content/guides";
import { config, isPreview } from "./config";
import { GUIDE_DRAFTS_FOLDER, readGuideDrafts, type GuideDraftProblem, type GuideDrafts } from "./guide-drafts";
import { guidesForExperience, sortGuides } from "./guides";

/**
 * The guides this deployment shows (ADR 0002): the published modules, plus the synthetic samples and the drafts of
 * `GUIDE_DRAFTS_DIR` in the mock preview. With the real API and no published guide, everything here is empty: /guides
 * answers 404, the sitemap and the footer leave guides out, and experience pages show no guides block.
 */
export type GuideCatalog = Readonly<{
  /** Every guide to show, newest first. A draft replaces the guide with the same slug (to check an edit before it ships). */
  guides: readonly Guide[];
  /** The slugs shown from a draft (preview only): "Draft" marks, a notice and noindex. */
  draftSlugs: readonly string[];
  /** Drafts that could not be shown, and why (preview only). */
  draftProblems: readonly GuideDraftProblem[];
}>;

const NO_DRAFTS: GuideDrafts = { guides: [], problems: [] };

async function readDrafts(): Promise<GuideDrafts> {
  const dir = isPreview ? config.guideDraftsDir : null;
  if (!dir) return NO_DRAFTS;
  try {
    return await readGuideDrafts(dir);
  } catch {
    // readGuideDrafts reports its own failures; whatever else goes wrong, drafts never break a page.
    return { guides: [], problems: [{ file: GUIDE_DRAFTS_FOLDER, reasons: ["the drafts could not be read"] }] };
  }
}

/** Read once per request (React `cache` is per request), never across requests: a saved draft shows on the next reload. */
export const guideCatalog = cache(async (): Promise<GuideCatalog> => {
  const drafts = await readDrafts();
  const bySlug = new Map(guideRegistry(isPreview).map((guide) => [guide.slug, guide]));
  for (const draft of drafts.guides) bySlug.set(draft.slug, draft);
  return { guides: sortGuides([...bySlug.values()]), draftSlugs: drafts.guides.map((guide) => guide.slug), draftProblems: drafts.problems };
});

/** /guides exists while it has a guide to list or (preview only) a draft problem to show; the footer links to it then. */
export function hasGuidesPage(catalog: GuideCatalog): boolean {
  return catalog.guides.length > 0 || catalog.draftProblems.length > 0;
}

export async function findGuide(slug: string): Promise<{ guide: Guide; draft: boolean } | null> {
  const catalog = await guideCatalog();
  const guide = catalog.guides.find((candidate) => candidate.slug === slug);
  return guide ? { guide, draft: catalog.draftSlugs.includes(slug) } : null;
}

export async function guidesAboutExperience(experienceSlug: string): Promise<{ guides: Guide[]; draftSlugs: readonly string[] }> {
  const catalog = await guideCatalog();
  return { guides: guidesForExperience(catalog.guides, experienceSlug), draftSlugs: catalog.draftSlugs };
}

/** The guides a sitemap may list: published (and the preview's samples), never a draft. Drafts are not even read here. */
export function indexableGuides(): Guide[] {
  return sortGuides(guideRegistry(isPreview));
}
