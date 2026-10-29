import "server-only";
import { cache } from "react";
import { guideRegistry, PUBLISHED_GUIDES, type Guide } from "@/content/guides";
import { config, isPreview } from "./config";
import { guideRepository } from "./experience/store-server";
import { GUIDE_DRAFTS_FOLDER, readGuideDrafts, type GuideDraftProblem, type GuideDrafts } from "./guide-drafts";
import { guidesForExperience, publicGuideArticleToGuide, sortGuides } from "./guides";

/**
 * The guides this deployment shows (ADR 0002): the published modules, plus the synthetic samples and the drafts of
 * `GUIDE_DRAFTS_DIR` in the mock preview. Unlisted editorial previews are intentionally absent from this catalog;
 * their direct route is resolved in `findGuide` without making /guides, the footer or sitemap visible.
 */
export type GuideCatalog = Readonly<{
  source: "static" | "database";
  /** Every guide to show, newest first. A draft replaces the guide with the same slug (to check an edit before it ships). */
  guides: readonly Guide[];
  /** The slugs shown from a draft (preview only): "Draft" marks, a notice and noindex. */
  draftSlugs: readonly string[];
  /** Drafts that could not be shown, and why (preview only). */
  draftProblems: readonly GuideDraftProblem[];
}>;

const NO_DRAFTS: GuideDrafts = { guides: [], problems: [] };
const GUIDE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

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
  if (config.guidePublicSource === "database") {
    const repository = guideRepository();
    if (repository === null) throw new Error("Guide database source is enabled without a database connection.");
    const articles = await repository.listPublicArticles();
    return {
      source: "database",
      guides: sortGuides(articles.map(publicGuideArticleToGuide)),
      draftSlugs: [],
      draftProblems: [],
    };
  }
  const drafts = await readDrafts();
  const bySlug = new Map(guideRegistry(isPreview).map((guide) => [guide.slug, guide]));
  for (const draft of drafts.guides) bySlug.set(draft.slug, draft);
  return { source: "static", guides: sortGuides([...bySlug.values()]), draftSlugs: drafts.guides.map((guide) => guide.slug), draftProblems: drafts.problems };
});

const databaseGuide = cache(async (slug: string): Promise<Guide | null> => {
  if (!GUIDE_SLUG.test(slug) || slug.length > 160) return null;
  const repository = guideRepository();
  if (repository === null) throw new Error("Guide database source is enabled without a database connection.");
  const article = await repository.getPublicArticleBySlug(slug);
  return article === null ? null : publicGuideArticleToGuide(article);
});

/** /guides exists while it has a guide to list or (preview only) a draft problem to show; the footer links to it then. */
export function hasGuidesPage(catalog: GuideCatalog): boolean {
  return catalog.guides.length > 0 || catalog.draftProblems.length > 0;
}

export async function findGuide(slug: string): Promise<{ guide: Guide; draft: boolean; unlisted?: true; editorialPreview?: true } | null> {
  if (config.guidePublicSource === "database") {
    const guide = await databaseGuide(slug);
    return guide === null ? null : { guide, draft: false, ...(guide.unlisted ? { unlisted: true as const } : {}) };
  }
  const catalog = await guideCatalog();
  const guide = catalog.guides.find((candidate) => candidate.slug === slug);
  if (guide) return { guide, draft: catalog.draftSlugs.includes(slug) };
  const unlisted = PUBLISHED_GUIDES.find((candidate) => candidate.unlisted && candidate.slug === slug);
  return unlisted ? { guide: unlisted, draft: false, unlisted: true, editorialPreview: true } : null;
}

export async function guidesAboutExperience(experienceSlug: string): Promise<{ guides: Guide[]; draftSlugs: readonly string[] }> {
  const catalog = await guideCatalog();
  return { guides: guidesForExperience(catalog.guides, experienceSlug), draftSlugs: catalog.draftSlugs };
}

/** The guides a sitemap may list: current PUBLIC database publications or code publications, never drafts/UNLISTED. */
export async function indexableGuides(): Promise<Guide[]> {
  if (config.guidePublicSource === "database") return [...(await guideCatalog()).guides];
  return sortGuides(guideRegistry(isPreview));
}
