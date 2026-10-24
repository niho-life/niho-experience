import "server-only";
import { NO_JOURNEY_EXTRAS, usableConditions, type ExperienceReviewSummary, type JourneyDetailExtras } from "@niho-experience/api-client";
import { config } from "./config";

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * The guest-journey data that the NIHO contract does not carry yet (Epic #103): participation conditions, whether questions
 * to the host are open, and the reviews. Only the mock serves it; with a real API this is empty and the screens show none of
 * the new parts. When NIHO's contract lands, read and validate it here so the screens keep using `JourneyDetailExtras`.
 * `?mock=reviews-error` makes the reviews read fail (the mock preview only), to see the page without them.
 */
export async function getJourneyExtras(slug: string, searchParams?: SearchParams): Promise<JourneyDetailExtras> {
  if (config.journeyApi !== "mock") return NO_JOURNEY_EXTRAS;
  const { journeyExtrasFor } = await import("@niho-experience/api-client/mock");
  const extras = journeyExtrasFor(slug);
  return {
    enabled: extras.enabled,
    conditions: usableConditions(extras.conditions),
    questionsOpen: extras.questionsOpen,
    reviews: searchParams?.mock === "reviews-error" ? { status: "unavailable" } : extras.reviews,
  };
}

/** The review summaries of the listed experiences, for the cards. Only experiences that have reviews are in the map. */
export async function getReviewSummaries(slugs: readonly string[]): Promise<Map<string, ExperienceReviewSummary>> {
  const summaries = new Map<string, ExperienceReviewSummary>();
  if (config.journeyApi !== "mock") return summaries;
  const { reviewsResponseFor } = await import("@niho-experience/api-client/mock");
  for (const slug of slugs) {
    const { summary } = reviewsResponseFor(slug, 1);
    if (summary.count > 0) summaries.set(slug, summary);
  }
  return summaries;
}
