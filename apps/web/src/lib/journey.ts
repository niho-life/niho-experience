import "server-only";
import { NO_JOURNEY_EXTRAS, usableConditions, usableFaq, type ExperienceReviewSummary, type JourneyDetailExtras } from "@niho-experience/api-client";
import { config } from "./config";
import { guestQuestionRepository } from "./experience/store-server";

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
