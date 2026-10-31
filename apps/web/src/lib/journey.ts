import "server-only";
import { NO_JOURNEY_EXTRAS, usableConditions, usableFaq, type ExperienceReviewSummary, type JourneyDetailExtras, type JourneyReviews } from "@niho-experience/api-client";
import { config } from "./config";
import { guestQuestionRepository, guestReviewRepository } from "./experience/store-server";

/** The experience page renders the newest reviews; "Show all" reads the rest in the browser. */
const DETAIL_REVIEW_LIMIT = 3;

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * The guest-journey data that the NIHO contract does not carry yet (Epic #103): participation conditions, whether questions
 * to the host are open, the reviews, and the FAQ (#146; the NIHO-side contract still has to be requested). Only the mock serves it; with a real API this is empty and the screens show none of
 * the new parts, except questions to the host, which the experience DB keeps (questionsOpen below). When NIHO's contract lands, read and validate it here so the screens keep using `JourneyDetailExtras`.
 * `?mock=reviews-error` makes the reviews read fail (the mock preview only), to see the page without them.
 */
export async function getJourneyExtras(slug: string, searchParams?: SearchParams): Promise<JourneyDetailExtras> {
  if (config.journeyApi !== "mock") return { ...NO_JOURNEY_EXTRAS, questionsOpen: await questionsOpen(slug) };
  const { journeyExtrasFor } = await import("@niho-experience/api-client/mock");
  const extras = journeyExtrasFor(slug);
  return {
    enabled: extras.enabled,
    conditions: usableConditions(extras.conditions),
    questionsOpen: extras.questionsOpen,
    reviews: searchParams?.mock === "reviews-error" ? { status: "unavailable" } : extras.reviews,
    faq: usableFaq(extras.faq),
  };
}

/**
 * http mode: "Ask the host" (#105) is offered for an experience the experience DB has PUBLISHED, once
 * EXPERIENCE_GUEST_QUESTIONS_ENABLED is on (docs/guest-questions.md). A DB that cannot be read hides it.
 */
async function questionsOpen(slug: string): Promise<boolean> {
  const questions = guestQuestionRepository();
  if (!questions) return false;
  try {
    return await questions.questionsOpen(slug);
  } catch {
    return false;
  }
}

/**
 * http mode: 予約者のレビュー (#104) of an experience the experience DB has PUBLISHED, once
 * EXPERIENCE_GUEST_REVIEWS_ENABLED is on (docs/guest-reviews.md): the newest and the summary of all.
 * Null while it is off, without the DB, or for an experience not published there: no section, no "New".
 * A DB that cannot be read is `unavailable`, which the page tells apart from no reviews.
 */
export async function getLiveReviews(slug: string): Promise<JourneyReviews | null> {
  const reviews = guestReviewRepository();
  if (!reviews) return null;
  try {
    const found = await reviews.listPublishedReviews(slug, { limit: DETAIL_REVIEW_LIMIT });
    return found ? { status: "ok", summary: found.summary, items: found.reviews } : null;
  } catch (error) {
    console.error("Experience page guest reviews failed", { error: error instanceof Error ? error.name : typeof error });
    return { status: "unavailable" };
  }
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
