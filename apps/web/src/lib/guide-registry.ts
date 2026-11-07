import "server-only";
import { cache } from "react";
import { guideRegistry, type Guide } from "@/content/guides";
import { config, isPreview } from "./config";
import { isEditorGuideSlug } from "./editor-publication/contract";
import { findEditorGuide, readEditorPublications } from "./editor-publication/source";
import { guideRepository } from "./experience/store-server";
import { GUIDE_DRAFTS_FOLDER, readGuideDrafts, type GuideDraftProblem, type GuideDrafts } from "./guide-drafts";
import { guidesForExperience, publicGuideArticleToGuide, sortGuides } from "./guides";

/**
 * The guides this deployment shows (ADR 0002): the published modules, plus the synthetic samples and the drafts of
 * `GUIDE_DRAFTS_DIR` in the mock preview. Unlisted editorial previews are intentionally absent from this catalog;
 * their direct route is resolved in `findGuide` without making /guides, the footer or sitemap visible.
 * The database and editor sources (http mode only) replace all of that: no static guide is ever mixed in.
 */
export type GuideCatalog = Readonly<{
  source: "static" | "database" | "editor";
  /** Every guide to show, newest first. A draft replaces the guide with the same slug (to check an edit before it ships). */
  guides: readonly Guide[];
  /** The slugs shown from a draft (preview only): "Draft" marks, a notice and noindex. */
  draftSlugs: readonly string[];
  /** Drafts that could not be shown, and why (preview only). */
  draftProblems: readonly GuideDraftProblem[];
}>;

const NO_DRAFTS: GuideDrafts = { guides: [], problems: [] };
const GUIDE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RELATED_AUTHORITY_CONCURRENCY = 4;

async function mapWithConcurrency<T, U>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T) => Promise<U>,
): Promise<U[]> {
  const results = new Array<U>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index]!);
    }
  }));
  return results;
}

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

/** editor.niho.life's publications, read once per request (the API client keeps its own short cache across requests). */
const editorPublications = cache(readEditorPublications);

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
  if (config.guidePublicSource === "editor") {
    return { source: "editor", guides: (await editorPublications()).live, draftSlugs: [], draftProblems: [] };
  }
  const drafts = await readDrafts();
  const bySlug = new Map(guideRegistry(isPreview).map((guide) => [guide.slug, guide]));
  for (const draft of drafts.guides) bySlug.set(draft.slug, draft);
  return { source: "static", guides: sortGuides([...bySlug.values()]), draftSlugs: drafts.guides.map((guide) => guide.slug), draftProblems: drafts.problems };
});

const emptySiteCatalog = (source: "database" | "editor"): GuideCatalog => ({ source, guides: [], draftSlugs: [], draftProblems: [] });

/**
 * The catalog for pages that only mention guides (the footer link, the home journal, the experience list and detail):
 * a database/editor outage hides those optional mentions instead of failing booking pages. The guide pages themselves use
 * `guideCatalog` and fail into their local error boundary. Static never needs a remote fallback.
 */
export const guideCatalogForSite = cache(async (): Promise<GuideCatalog> => {
  const source = config.guidePublicSource;
  if (source === "static") return guideCatalog();
  try {
    return await guideCatalog();
  } catch {
    console.error(`[guides] ${source} publications unavailable; guides hidden on optional page`);
    return emptySiteCatalog(source);
  }
});

const databaseGuide = cache(async (slug: string): Promise<Guide | null> => {
  if (!GUIDE_SLUG.test(slug) || slug.length > 160) return null;
  const repository = guideRepository();
  if (repository === null) throw new Error("Guide database source is enabled without a database connection.");
  const article = await repository.getPublicArticleBySlug(slug);
  return article === null ? null : publicGuideArticleToGuide(article);
});

const editorGuide = cache(async (slug: string): Promise<Guide | null> => {
  // A malformed or reserved slug never reaches the network.
  if (!isEditorGuideSlug(slug)) return null;
  return findEditorGuide(await editorPublications(), slug);
});

/** /guides exists while it has a guide to list or (preview only) a draft problem to show; the footer links to it then. */
export function hasGuidesPage(catalog: GuideCatalog): boolean {
  return catalog.guides.length > 0 || catalog.draftProblems.length > 0;
}

export async function findGuide(slug: string): Promise<{ guide: Guide; draft: boolean; unlisted?: true } | null> {
  if (config.guidePublicSource === "database") {
    const guide = await databaseGuide(slug);
    return guide === null ? null : { guide, draft: false, ...(guide.unlisted ? { unlisted: true as const } : {}) };
  }
  if (config.guidePublicSource === "editor") {
    const guide = await editorGuide(slug);
    return guide === null ? null : { guide, draft: false, ...(guide.unlisted ? { unlisted: true as const } : {}) };
  }
  const catalog = await guideCatalog();
  const guide = catalog.guides.find((candidate) => candidate.slug === slug);
  if (guide) return { guide, draft: catalog.draftSlugs.includes(slug) };
  return null;
}

/**
 * Where `/guides/{slug}` sends a visitor when `findGuide` has no guide (editor source only): an unpublished, not yet
 * published or misspelt guide goes back to /guides while /guides lists something. A temporary redirect, since a guide
 * republishes under the same URL. Null means 404 (every other source, a malformed slug, or an empty /guides).
 */
export async function missingGuideRedirect(slug: string): Promise<"/guides" | null> {
  if (config.guidePublicSource !== "editor" || !isEditorGuideSlug(slug)) return null;
  return hasGuidesPage(await guideCatalog()) ? "/guides" : null;
}

export async function guidesAboutExperience(experienceSlug: string): Promise<{ guides: Guide[]; draftSlugs: readonly string[] }> {
  const catalog = await guideCatalogForSite();
  if (config.guidePublicSource !== "editor") return { guides: guidesForExperience(catalog.guides, experienceSlug), draftSlugs: catalog.draftSlugs };
  const related = catalog.guides.filter((guide) => guide.relatedExperienceSlugs.includes(experienceSlug));
  const { filterCurrentRelatedGuide } = await import("./article-authority/publication-read");
  const checked = await mapWithConcurrency(related, RELATED_AUTHORITY_CONCURRENCY, filterCurrentRelatedGuide);
  return { guides: guidesForExperience(checked, experienceSlug), draftSlugs: catalog.draftSlugs };
}

/** The guides a sitemap may list: current PUBLIC database or live editor publications, or code publications; never drafts/UNLISTED. */
export async function indexableGuides(): Promise<Guide[]> {
  if (config.guidePublicSource === "database" || config.guidePublicSource === "editor") return [...(await guideCatalog()).guides];
  return sortGuides(guideRegistry(isPreview));
}
