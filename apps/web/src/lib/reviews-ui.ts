import { REVIEW_AVERAGE_MIN_COUNT, type ExperienceReviewSummary, type JourneyReviews } from "@niho-experience/api-client";
import type { DetailReviewHeadlineV1 } from "@niho/experience-presentation/v1";
import type { CardModel } from "./card-model";

/**
 * How reviews are shown (Epic #103, niho-experience#104). The average and the stars appear from three reviews (owner decision
 * 2026-10-22); with one or two, only the count and the written reviews. No reviews yet is "New". A read that failed is not
 * "no reviews". Pure so it can be tested: the data comes from `lib/journey.ts`.
 */
export type ReviewDisplay =
  | { kind: "off" }
  | { kind: "unavailable" }
  | { kind: "none" }
  | { kind: "few"; count: number }
  | { kind: "rated"; count: number; average: number };

export function summaryDisplay(summary: ExperienceReviewSummary): Exclude<ReviewDisplay, { kind: "off" | "unavailable" }> {
  if (summary.count <= 0) return { kind: "none" };
  if (summary.count >= REVIEW_AVERAGE_MIN_COUNT && summary.average !== null) return { kind: "rated", count: summary.count, average: summary.average };
  return { kind: "few", count: summary.count };
}

export function reviewDisplay(reviews: JourneyReviews | null): ReviewDisplay {
  if (!reviews) return { kind: "off" };
  return reviews.status === "unavailable" ? { kind: "unavailable" } : summaryDisplay(reviews.summary);
}

export const countLabel = (count: number) => `${count} ${count === 1 ? "review" : "reviews"}`;
/** One decimal, as shown: 4.92 → "4.9". */
export const averageLabel = (average: number) => (Math.round(average * 10) / 10).toFixed(1);

/** The line under the title: "★ 4.9 · 12 reviews" (link to the reviews), "2 reviews" (link), or the "New" badge. Nothing when there is no review feature or the read failed. */
export function reviewHeadline(display: ReviewDisplay): DetailReviewHeadlineV1 | null {
  switch (display.kind) {
    case "rated":
      return { label: `★ ${averageLabel(display.average)} · ${countLabel(display.count)}`, accessibleLabel: `Rated ${averageLabel(display.average)} out of 5 from ${countLabel(display.count)}. Go to the reviews`, href: "#reviews" };
    case "few":
      return { label: countLabel(display.count), accessibleLabel: `${countLabel(display.count)}. Go to the reviews`, href: "#reviews" };
    case "none":
      return { label: "New", isNew: true };
    default:
      return null;
  }
}

/** The card's line: only experiences that have reviews. "★ 4.9 · 12", or "2 reviews" under three. */
export function cardReviewLine(summary: ExperienceReviewSummary | null | undefined): { text: string; label: string } | null {
  if (!summary) return null;
  const display = summaryDisplay(summary);
  if (display.kind === "rated") return { text: `★ ${averageLabel(display.average)} · ${display.count}`, label: `Rated ${averageLabel(display.average)} out of 5 from ${countLabel(display.count)}` };
  if (display.kind === "few") return { text: countLabel(display.count), label: countLabel(display.count) };
  return null;
}

/** Adds the review line to the cards that have one. */
export function withReviewLines(cards: CardModel[], summaries: ReadonlyMap<string, ExperienceReviewSummary>): CardModel[] {
  return cards.map((card) => {
    const line = cardReviewLine(summaries.get(card.slug));
    return line ? { ...card, reviewLine: line } : card;
  });
}

/** "November 2026" for a publication time, in Japan time like every other date on the site. */
export function monthYear(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "Asia/Tokyo" }).format(date);
}

/** Spoken form of a rating: "Rated 5 out of 5", "Rated 4.9 out of 5". */
export const ratingLabel = (rating: number) => `Rated ${Number.isInteger(rating) ? rating : averageLabel(rating)} out of 5`;
