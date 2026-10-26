import "server-only";
import { getApi, listExperiencesForSite } from "../api";
import { buildCardModels, type CardModel } from "../card-model";
import { loadDetails } from "../catalog";
import { config, isPilotPreview } from "../config";
import { getReviewSummaries } from "../journey";
import { withReviewLines } from "../reviews-ui";

/**
 * Cards for the experiences a guide recommends, from the same catalog the site lists. Slugs the catalog
 * does not have are left out, and a catalog that cannot be read gives no cards: the article still renders.
 */
export async function guideExperienceCards(slugs: readonly string[]): Promise<Map<string, CardModel>> {
  if (!slugs.length) return new Map();
  try {
    const [api, result] = await Promise.all([getApi(), listExperiencesForSite("kamakura")]);
    if (!result.ok) return new Map();
    const summaries = result.data.experiences.filter((summary) => slugs.includes(summary.slug));
    if (!summaries.length) return new Map();
    const details = await loadDetails(api, summaries, config.publicApiVersion !== "1.0");
    const cards = withReviewLines(buildCardModels(summaries, details, isPilotPreview), await getReviewSummaries(summaries.map((summary) => summary.slug)));
    return new Map(cards.map((card) => [card.slug, card]));
  } catch (error) {
    console.error("[guides] experience cards unavailable", error instanceof Error ? error.message : error);
    return new Map();
  }
}
