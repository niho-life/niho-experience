import { HOST_REVIEWS_PATH, withQuery } from "@/lib/host/routes";
import { monthDayJa, shortDateWithWeekdayJa } from "./format";
import { replyDraftState, type ReplyDraft, type ReplyDraftState } from "./messages";
import type { HostReview, HostReviewReply, HostReviewReportReason } from "./types";

/*
 * レビュー (#108)'s rules, apart from the screen so they can be tested: the summary (published
 * reviews only; the experience site shows an average from three), the order, which reviews ホーム
 * brings up, when the host may reply, and what publishing, correcting and reporting change. NIHO
 * checks a review before it is published and keeps it as the guest wrote it: the host replies
 * once (and may correct the reply) and may report it, never remove or change it. In mock mode
 * the screen keeps a reply or a report on the page only.
 * TODO(#87): publish the reply and send the report to NIHO (niho-app#19314), and show what it reads back.
 */

/**
 * よかった点: the fixed choices a guest picks from, in their order. A review keeps the
 * identifiers; the host reads the labels.
 */
export const REVIEW_TAGS = [
  { value: "CALM_ATMOSPHERE", label: "落ち着いた雰囲気" },
  { value: "GOOD_FOR_BEGINNERS", label: "初めてでも安心" },
  { value: "EASY_TO_FIND", label: "場所が分かりやすい" },
  { value: "GREAT_HOST", label: "すてきなホスト" },
  { value: "GOOD_VALUE", label: "値段に見合う" },
] as const;
/** One of よかった点's identifiers. TODO(#87): match them to NIHO's API once it has reviews (niho-coliving/niho-app#19314). */
export type HostReviewTag = (typeof REVIEW_TAGS)[number]["value"];

/** よかった点 in the host's words, in the choices' order (an identifier the screen does not know is left out). */
export function reviewTagLabels(tags: readonly string[]): string[] {
  return REVIEW_TAGS.filter((choice) => tags.includes(choice.value)).map((choice) => choice.label);
}

/** What one reply may hold. TODO(#87): NIHO's own limit once the contract has reviews. */
export const REVIEW_REPLY_TEXT_LIMIT = 2000;
/** What the report's ひとこと may hold. */
export const REVIEW_REPORT_NOTE_LIMIT = 500;
/** The experience site shows the average from this many published reviews (#104). */
export const SITE_AVERAGE_FROM = 3;
/** ホーム brings up this many reviews at most, then "ほかに N 件". */
export const HOME_REVIEW_LIMIT = 3;

/** In place of the reply while NIHO checks the review. */
export const REVIEW_WAITING_TEXT = "NIHO が確認中です。公開されたら返信できます";
export const REVIEW_REPORTED_TEXT = "報告しました · NIHO が確認します";
export const REVIEW_SITE_AVERAGE_TEXT = `体験サイトでは ${SITE_AVERAGE_FROM} 件から平均を出します`;

export const REVIEW_REPORT_REASONS: readonly { value: HostReviewReportReason; label: string }[] = [
  { value: "personal", label: "個人情報が書かれている" },
  { value: "untrue", label: "事実と違う" },
  { value: "inappropriate", label: "不適切な内容" },
  { value: "other", label: "その他" },
];

export interface ReviewsQuery {
  providerId?: string | null;
  /** One experience's reviews. */
  experience?: string | null;
  /** One review to scroll to (`#review-{id}`). */
  review?: string | null;
}

/** The element of one review on the screen, and the hash that leads there. */
export function reviewAnchor(id: string): string {
  return `review-${id}`;
}

/** The review a hash leads to ("#review-rv-5020" → "rv-5020"), or null. */
export function reviewIdFromHash(hash: string): string | null {
  const match = /^#?review-(.+)$/.exec(hash);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

/** The reviews screen's address: `?providerId=`, the experience, then `#review-{id}`. */
export function reviewsHref({ providerId, experience, review }: ReviewsQuery = {}): string {
  const href = withQuery(HOST_REVIEWS_PATH, { providerId, experience });
  return review ? `${href}#${reviewAnchor(encodeURIComponent(review))}` : href;
}

/** The newest first (when the guest wrote it). */
export function sortReviews<T extends Pick<HostReview, "id" | "writtenAt">>(reviews: readonly T[]): T[] {
  return [...reviews].sort((a, b) => b.writtenAt.localeCompare(a.writtenAt) || a.id.localeCompare(b.id));
}

/** One experience's reviews, or all of them. */
export function reviewsOf<T extends Pick<HostReview, "experienceId">>(reviews: readonly T[], experienceId: string | null): T[] {
  return experienceId ? reviews.filter((review) => review.experienceId === experienceId) : [...reviews];
}

export interface ReviewSummary {
  /** 公開中. */
  published: number;
  /** 公開前: NIHO is checking them. */
  pending: number;
  /** The published reviews' average to one decimal ("4.8"); null without any. */
  average: string | null;
  /** The experience site shows that average (#104): from SITE_AVERAGE_FROM published reviews. */
  onSite: boolean;
}

/** 1–5, whatever came. */
function stars(rating: number): number {
  return Math.min(5, Math.max(1, Math.round(rating)));
}

/** The average of the published reviews only: a review NIHO has not published counts nowhere yet. */
export function reviewSummary(reviews: readonly Pick<HostReview, "status" | "rating">[]): ReviewSummary {
  const published = reviews.filter((review) => review.status === "published");
  const total = published.reduce((sum, review) => sum + stars(review.rating), 0);
  return {
    published: published.length,
    pending: reviews.length - published.length,
    average: published.length ? (Math.round((total / published.length) * 10) / 10).toFixed(1) : null,
    onSite: published.length >= SITE_AVERAGE_FROM,
  };
}

/** The lines under the summary: "公開前 1 件" and, below three published reviews, why the site shows no average yet. None without reviews. */
export function reviewSummaryNotes(summary: ReviewSummary): string[] {
  return [...(summary.pending ? [`公開前 ${summary.pending} 件`] : []), ...(summary.published + summary.pending > 0 && !summary.onSite ? [REVIEW_SITE_AVERAGE_TEXT] : [])];
}

/** 体験's "★ 4.8 · 5 件" for one experience: its published reviews; null without any. */
export function experienceRating(reviews: readonly Pick<HostReview, "experienceId" | "status" | "rating">[], experienceId: string): { average: string; count: number } | null {
  const summary = reviewSummary(reviewsOf(reviews, experienceId));
  return summary.average ? { average: summary.average, count: summary.published } : null;
}

/** The stars as drawn: "★★★★" and "☆" for 4 (the shape, not only the color, tells them apart). */
export function ratingStars(rating: number): { filled: string; empty: string } {
  const count = stars(rating);
  return { filled: "★".repeat(count), empty: "☆".repeat(5 - count) };
}

/** The stars for screen readers: "5 点中 4 点". */
export function ratingLabel(rating: number): string {
  return `5 点中 ${stars(rating)} 点`;
}

/** "Oliver さん · イギリス". */
export function reviewerLabel(review: Pick<HostReview, "reviewer">): string {
  return [`${review.reviewer.name} さん`, review.reviewer.country].filter(Boolean).join(" · ");
}

/** "10/17（土）Kamakura Community Dinner with Locals": the session the review is about. */
export function reviewSessionLabel(review: Pick<HostReview, "sessionDate">, title: string): string {
  return `${shortDateWithWeekdayJa(review.sessionDate)}${title}`;
}

/**
 * Where the reply stands: NIHO is checking the review (`waiting`: nothing to answer yet), it is
 * published without a reply (`open`: 返信する), or the host replied (`replied`: 返信を直す).
 */
export type ReviewReplyStage = "waiting" | "open" | "replied";

export function reviewReplyStage(review: Pick<HostReview, "status" | "reply">): ReviewReplyStage {
  if (review.status !== "published") return "waiting";
  return review.reply ? "replied" : "open";
}

/** "10月20日に公開", and "10月21日に直しました" once corrected. */
export function replyDates(reply: Pick<HostReviewReply, "publishedAt" | "editedAt">): { published: string; edited: string | null } {
  return {
    published: `${monthDayJa(reply.publishedAt.slice(0, 10))}に公開`,
    edited: reply.editedAt ? `${monthDayJa(reply.editedAt.slice(0, 10))}に直しました` : null,
  };
}

/**
 * 返信を直す starts from the published reply: its English counts as made from its Japanese, so
 * changing the Japanese asks for the English again. A reply written in English directly stays
 * the host's own English.
 */
export function replyDraftFrom(reply: Pick<HostReviewReply, "japanese" | "english">): ReplyDraft {
  return { japanese: reply.japanese, english: reply.english, madeFrom: reply.japanese || null };
}

export interface ReviewReplyDraftState extends ReplyDraftState {
  /** 返信を直す without a change yet: nothing to publish. */
  unchanged: boolean;
}

/** 返信を公開する waits for an English that is there, not older than the Japanese, and (when correcting) different from the published reply. */
export function reviewReplyDraftState(draft: ReplyDraft, published: Pick<HostReviewReply, "japanese" | "english"> | null): ReviewReplyDraftState {
  const state = replyDraftState(draft);
  const unchanged = published !== null && draft.japanese.trim() === published.japanese && draft.english.trim() === published.english;
  return { ...state, canSend: state.canSend && !unchanged, unchanged };
}

/**
 * 返信を公開する (mock mode: on this screen only): the first reply, or the correction of the one
 * there (dated, its first publication kept). Nothing happens before NIHO publishes the review,
 * without English, or without a change.
 */
export function publishReviewReply(review: HostReview, reply: { japanese: string; english: string }, at: string): HostReview {
  const english = reply.english.trim();
  const japanese = reply.japanese.trim();
  if (review.status !== "published" || !english) return review;
  if (!review.reply) return { ...review, reply: { japanese, english, publishedAt: at, editedAt: null } };
  if (review.reply.japanese === japanese && review.reply.english === english) return review;
  return { ...review, reply: { ...review.reply, japanese, english, editedAt: at } };
}

/** NIHO に報告する, once per review: the review stays as it is until NIHO decides. */
export function reportReview(review: HostReview, reason: HostReviewReportReason, at: string, note = ""): HostReview {
  const trimmedNote = note.trim();
  return review.report ? review : { ...review, report: { at, reason, ...(trimmedNote ? { note: trimmedNote } : {}) } };
}

/**
 * What ホーム brings up: the published reviews without a reply (the newest first), then the ones
 * NIHO is still checking (to read before they are published).
 */
export function reviewsToAttend<T extends HostReview>(reviews: readonly T[]): T[] {
  const sorted = sortReviews(reviews);
  return [...sorted.filter((review) => reviewReplyStage(review) === "open"), ...sorted.filter((review) => reviewReplyStage(review) === "waiting")];
}
