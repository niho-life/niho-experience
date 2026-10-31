import type { HostReview } from "@/host/types";

/*
 * レビュー's writes to the experience DB (#108, `live`), apart from the screen so they can be tested:
 * the browser's command id for a reply or a report, kept while the same thing is tried again so a
 * retry is the same command, and the review and reply revision the store answers with.
 */

/** What the host sends about one review. */
export type ReviewWrite = "reply" | "report";

export interface ReviewAttempt {
  /** What is tried: the review, and the reply's words or the report's reason and word. */
  readonly signature: string;
  readonly commandId: string;
}

export const replySignature = (reviewId: string, reply: { japanese: string; english: string }): string => JSON.stringify(["reply", reviewId, reply.japanese, reply.english]);
export const reportSignature = (reviewId: string, reason: string, note: string): string => JSON.stringify(["report", reviewId, reason, note]);

/** The same try again keeps its command id; anything else is a new command. */
export function reviewAttempt(previous: ReviewAttempt | undefined, signature: string, newId: () => string): ReviewAttempt {
  return previous?.signature === signature ? previous : { signature, commandId: newId() };
}

/** The review the store answered takes its place on the list. */
export function withSavedReview(reviews: readonly HostReview[], saved: HostReview): HostReview[] {
  return reviews.map((review) => (review.id === saved.id ? saved : review));
}

/** The reply's revision the next correction is checked against. */
export function withRevision(revisions: Readonly<Record<string, number>>, reviewId: string, revision: number): Record<string, number> {
  return { ...revisions, [reviewId]: revision };
}
