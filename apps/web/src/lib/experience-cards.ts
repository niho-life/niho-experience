import "server-only";
import { getApi, listExperiencesForSite } from "./api";
import { buildCardModels, type CardModel } from "./card-model";
import { loadDetails } from "./catalog";
import { config, isPilotPreview } from "./config";
import type { ExperienceSummaryForSite } from "./experience-types";
import type { SearchParams } from "./filters";
import { getReviewSummaries } from "./journey";
import { pickRelatedExperiences } from "./related-experiences";
import { withReviewLines } from "./reviews-ui";

/** Only the mock scenario switch carries over: the browse filters of the current page must not narrow a suggestion list. */
const listQuery = (query?: SearchParams): SearchParams => (typeof query?.mock === "string" ? { mock: query.mock } : {});

/** The listed experiences for suggestions (guides, related experiences), or null when the catalogue cannot be read. */
export async function readListedExperiences(query?: SearchParams): Promise<ExperienceSummaryForSite[] | null> {
  try {
    const result = await listExperiencesForSite("kamakura", listQuery(query));
    return result.ok ? result.data.experiences : null;
  } catch {
    return null;
  }
}

/** Card models for a few listed experiences, in the given order. A detail that cannot be read falls back to the summary. */
export async function cardsFor(summaries: ExperienceSummaryForSite[], query?: SearchParams): Promise<CardModel[]> {
  if (!summaries.length) return [];
  try {
    const api = await getApi(listQuery(query));
    const details = await loadDetails(api, summaries, config.publicApiVersion !== "1.0");
    return withReviewLines(buildCardModels(summaries, details, isPilotPreview), await getReviewSummaries(summaries.map((summary) => summary.slug)));
  } catch {
    return [];
  }
}

/** Cards for 2–3 other listed experiences (same themes first), or none when the catalogue cannot be read. */
export async function relatedExperienceCards(slug: string, query?: SearchParams, limit = 3): Promise<CardModel[]> {
  const listed = await readListedExperiences(query);
  return listed ? cardsFor(pickRelatedExperiences(slug, listed, limit), query) : [];
}
