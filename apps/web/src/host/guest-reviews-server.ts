import "server-only";
import {
  StoreAccessDeniedError,
  StoreConflictError,
  StoreNotFoundError,
  StoreValidationError,
  type GuestReviewReportReason,
  type GuestReviewRepository,
  type HostActor,
  type HostGuestReview,
  type HostGuestReviewPage,
  type HostGuestReviewProductSummary,
} from "@niho-experience/experience-store";
import { guestReviewRepository } from "@/lib/experience/store-server";
import type { HostProvider } from "@/lib/host/providers";
import { loadHostProviders, readHostSession } from "@/lib/host/server";
import { idTokenUsable } from "@/lib/host/session";
import { anthropicTranslator, type Translator } from "@/lib/translation/anthropic";
import { reviewReplyToEnglish } from "@/lib/translation/prompts";
import { actionTime } from "./bookings";
import { HOST_INVALID_INPUT_TEXT, HOST_SESSION_ENDED_TEXT } from "./errors";
import { todayInJapan } from "./format";
import { japanMinute, REPLY_DRAFT_TIMEOUT_MS } from "./guest-questions-server";
import { REPLY_DRAFT_FAILED_TEXT, REPLY_DRAFT_UNAVAILABLE_TEXT } from "./messages";
import type { HostActionResult } from "./payout";
import { REVIEW_REPORTED_TEXT, type ReviewCount } from "./reviews";
import type { HostReview, HostReviewReportReason } from "./types";

/*
 * レビュー's 予約者のレビュー (#108) kept in the experience DB (migration 0027, docs/guest-reviews.md).
 * A review is shown from the moment the guest writes it (NIHO does not check it first, owner
 * 2026-10-31), so every one on the list takes a reply. NIHO proves the account and that it is the
 * provider's OWNER; the experience store checks its own OWNER membership as well (ADR 0002). The
 * guest's email and phone never reach the console. A deployment without
 * EXPERIENCE_GUEST_REVIEWS_ENABLED and the DB keeps today's screen.
 */

export const GUEST_REVIEW_OWNER_ONLY_TEXT = "レビューはオーナーが読み書きできます";
/** Also a review operations hid meanwhile. */
export const GUEST_REVIEW_MISSING_TEXT = "このレビューは見つかりませんでした。ページを読み込み直してください。";
export const GUEST_REVIEW_LOAD_FAILED_TEXT = "レビューを読み込めませんでした。時間をおいて、もう一度お試しください。";
export const GUEST_REVIEW_REPLY_FAILED_TEXT = "返信を公開できませんでした。時間をおいて、もう一度お試しください。";
export const GUEST_REVIEW_REPLY_CHANGED_TEXT = "返信がほかの画面で変わっています。レビューを読み込み直してください";
export const GUEST_REVIEW_REPORT_FAILED_TEXT = "報告できませんでした。時間をおいて、もう一度お試しください。";
export const GUEST_REVIEW_ALREADY_REPORTED_TEXT = "すでに報告されています";

/** The list reads this many reviews at a time, the latest first (続きを見る reads the next ones). */
const LIST_LIMIT = 100;

const REASON_FROM_STORE: Record<GuestReviewReportReason, HostReviewReportReason> = { PERSONAL: "personal", UNTRUE: "untrue", INAPPROPRIATE: "inappropriate", OTHER: "other" };
const REASON_TO_STORE: Record<HostReviewReportReason, GuestReviewReportReason> = { personal: "PERSONAL", untrue: "UNTRUE", inappropriate: "INAPPROPRIATE", other: "OTHER" };

function ownerActor(providerId: string, nihoUserId: string): HostActor {
  return { providerId, nihoUserId, calendarRoleCeiling: "OWNER" };
}

/**
 * One stored review as レビュー shows it: the guest's words (translation still null until NIHO makes
 * one), dated in Japan. Published when written, so never 公開前.
 */
export function hostReviewFrom(review: HostGuestReview): HostReview {
  const language = review.language === "JA" ? "ja" : "en";
  const { reply, report } = review;
  const writtenAt = japanMinute(review.submittedAtUtc);
  return {
    id: review.id,
    experienceId: review.productId,
    bookingId: review.bookingPublicId,
    sessionDate: todayInJapan(Date.parse(review.sessionStartUtc)),
    reviewer: { name: review.reviewerName, country: review.reviewerOrigin ?? "" },
    rating: review.rating,
    tags: review.tags,
    body: { original: review.body, language, translation: review.bodyJa },
    privateNote: review.noteToHost ? { original: review.noteToHost, language, translation: null } : null,
    writtenAt,
    status: "published",
    publishedAt: writtenAt,
    reply: reply
      ? { japanese: reply.japanese ?? "", english: reply.english, publishedAt: japanMinute(reply.repliedAtUtc), editedAt: reply.editedAtUtc ? japanMinute(reply.editedAtUtc) : null }
      : null,
    report: report ? { at: japanMinute(report.reportedAtUtc), reason: REASON_FROM_STORE[report.reason], ...(report.note ? { note: report.note } : {}) } : null,
  };
}

/** The reply's revision a correction is checked against (0: no reply yet). */
const revisionOf = (review: HostGuestReview): number => review.reply?.revision ?? 0;

/** One page of reviews as レビュー shows them. */
export interface HostGuestReviewPageView {
  /** The latest first. */
  reviews: HostReview[];
  /** Each review's reply revision, by review id. */
  revisions: Record<string, number>;
  /** 続きを見る reads the rest from here; null when every review is on the screen. */
  nextCursor: string | null;
}

function pageView(page: HostGuestReviewPage): HostGuestReviewPageView {
  return {
    reviews: page.reviews.map(hostReviewFrom),
    revisions: Object.fromEntries(page.reviews.map((review) => [review.id, revisionOf(review)])),
    nextCursor: page.nextCursor,
  };
}

function countOf(summary: HostGuestReviewProductSummary): ReviewCount {
  return { experienceId: summary.productId, title: summary.productTitle, count: summary.count, ratingTotal: summary.ratingTotal };
}

export type HostGuestReviewsLoad =
  | (HostGuestReviewPageView & {
      status: "live";
      /** Every shown review counted by experience: the average, and the experiences the select offers. */
      counts: ReviewCount[];
      experiences: { id: string; title: string }[];
      now: string;
    })
  /** Not kept here: the flag is off or no DB. Today's screen. */
  | { status: "closed" }
  /** Kept here, but NIHO or the experience DB does not say this account is the provider's OWNER. */
  | { status: "owner-only" }
  | { status: "error" };

/** レビュー for an OWNER (NIHO's role): the provider's shown reviews. */
export async function loadGuestReviews(provider: Pick<HostProvider, "id" | "memberRole">, nihoUserId: string): Promise<HostGuestReviewsLoad> {
  const store = guestReviewRepository();
  if (!store) return { status: "closed" };
  if (provider.memberRole !== "OWNER") return { status: "owner-only" };
  try {
    const actor = ownerActor(provider.id, nihoUserId);
    const [page, summary] = await Promise.all([store.listReviews(actor, { limit: LIST_LIMIT }), store.summarizeReviews(actor)]);
    const counts = summary.map(countOf);
    const now = Date.now();
    return {
      status: "live",
      ...pageView(page),
      counts,
      experiences: counts.map((count) => ({ id: count.experienceId, title: count.title })),
      now: actionTime(todayInJapan(now), now),
    };
  } catch (error) {
    return error instanceof StoreAccessDeniedError ? { status: "owner-only" } : { status: "error" };
  }
}

type OwnerCheck = { ok: true; store: GuestReviewRepository; actor: HostActor } | { ok: false; message: string };

/** A usable session, the store, and NIHO saying this account owns the provider. */
async function asOwner(providerId: string, failed: string): Promise<OwnerCheck> {
  const session = await readHostSession();
  if (!session || !idTokenUsable(session, Date.now())) return { ok: false, message: HOST_SESSION_ENDED_TEXT };
  const store = guestReviewRepository();
  if (!store) return { ok: false, message: failed };
  const providers = await loadHostProviders();
  if (providers.status !== "ok") return { ok: false, message: providers.status === "error" ? failed : HOST_SESSION_ENDED_TEXT };
  const provider = providers.providers.find((entry) => entry.id === providerId);
  if (provider?.memberRole !== "OWNER") return { ok: false, message: GUEST_REVIEW_OWNER_ONLY_TEXT };
  return { ok: true, store, actor: ownerActor(providerId, session.nihoUserId) };
}

/** 続きを見る: the reviews after the screen's last one, from the cursor the previous page gave. */
export async function loadMoreGuestReviews(providerId: string, cursor: string): Promise<HostActionResult<HostGuestReviewPageView>> {
  const owner = await asOwner(providerId, GUEST_REVIEW_LOAD_FAILED_TEXT);
  if (!owner.ok) return owner;
  try {
    return { ok: true, message: "", ...pageView(await owner.store.listReviews(owner.actor, { cursor, limit: LIST_LIMIT })) };
  } catch (error) {
    if (error instanceof StoreAccessDeniedError) return { ok: false, message: GUEST_REVIEW_OWNER_ONLY_TEXT };
    if (error instanceof StoreValidationError) return { ok: false, message: HOST_INVALID_INPUT_TEXT };
    return { ok: false, message: GUEST_REVIEW_LOAD_FAILED_TEXT };
  }
}

/**
 * 英語にする for a review kept here (#108): the Claude API's English of the host's Japanese reply, with the
 * review as context, for the host to check and correct before publishing; nothing is published or saved
 * here. As for a question (draftGuestQuestionEnglish): translation off, the host writes the English
 * (REPLY_DRAFT_UNAVAILABLE_TEXT); on, but the API unreachable, slow (15 s), declining or answering nothing
 * usable, the host may try again or write the English (REPLY_DRAFT_FAILED_TEXT).
 */
export async function draftGuestReviewEnglish(
  providerId: string,
  reviewId: string,
  japanese: string,
  translator: () => Translator | null = () => anthropicTranslator({ timeoutMs: REPLY_DRAFT_TIMEOUT_MS }),
): Promise<HostActionResult<{ english: string }>> {
  const session = await readHostSession();
  if (!session || !idTokenUsable(session, Date.now())) return { ok: false, message: HOST_SESSION_ENDED_TEXT };
  const translate = translator();
  if (!translate) return { ok: false, message: REPLY_DRAFT_UNAVAILABLE_TEXT };
  const owner = await asOwner(providerId, REPLY_DRAFT_UNAVAILABLE_TEXT);
  if (!owner.ok) return owner;
  let review: HostGuestReview;
  try {
    // The OWNER's shown review only; its words are the context.
    review = await owner.store.getReview(owner.actor, reviewId);
  } catch (error) {
    if (error instanceof StoreAccessDeniedError) return { ok: false, message: GUEST_REVIEW_OWNER_ONLY_TEXT };
    if (error instanceof StoreNotFoundError) return { ok: false, message: GUEST_REVIEW_MISSING_TEXT };
    if (error instanceof StoreValidationError) return { ok: false, message: HOST_INVALID_INPUT_TEXT };
    return { ok: false, message: REPLY_DRAFT_FAILED_TEXT };
  }
  const result = await translate(reviewReplyToEnglish({ japanese, review: review.body }));
  return result.ok ? { ok: true, message: "英語にしました", english: result.text } : { ok: false, message: REPLY_DRAFT_FAILED_TEXT };
}

function failure(error: unknown, kind: "reply" | "report"): { ok: false; message: string } {
  if (error instanceof StoreAccessDeniedError) return { ok: false, message: GUEST_REVIEW_OWNER_ONLY_TEXT };
  // Another provider's, or one operations hid.
  if (error instanceof StoreNotFoundError) return { ok: false, message: GUEST_REVIEW_MISSING_TEXT };
  // A reply: another reply was saved since this one was read (or this command id came with other words). A report: there is one.
  if (error instanceof StoreConflictError) return { ok: false, message: kind === "reply" ? GUEST_REVIEW_REPLY_CHANGED_TEXT : GUEST_REVIEW_ALREADY_REPORTED_TEXT };
  if (error instanceof StoreValidationError) return { ok: false, message: HOST_INVALID_INPUT_TEXT };
  return { ok: false, message: kind === "reply" ? GUEST_REVIEW_REPLY_FAILED_TEXT : GUEST_REVIEW_REPORT_FAILED_TEXT };
}

/** The review as the store answers it now, and its reply's revision for the next correction. */
type Saved = { review: HostReview; revision: number };

/**
 * 返信を公開する / 返信を直す, on any shown review: the English the experience page shows, with the
 * Japanese the host wrote (none when they wrote the English directly), when the reply is still at
 * `expectedRevision`. `commandId` comes from the browser, so a retry is the same reply.
 */
export async function saveGuestReviewReply(
  providerId: string,
  reviewId: string,
  reply: { japanese: string; english: string; commandId: string; expectedRevision: number },
): Promise<HostActionResult<Saved>> {
  const owner = await asOwner(providerId, GUEST_REVIEW_REPLY_FAILED_TEXT);
  if (!owner.ok) return owner;
  try {
    const saved = await owner.store.saveReply(owner.actor, reviewId, {
      english: reply.english,
      japanese: reply.japanese.trim() || null,
      commandId: reply.commandId,
      expectedRevision: reply.expectedRevision,
    });
    return { ok: true, message: reply.expectedRevision > 0 ? "返信を直しました" : "返信を公開しました", review: hostReviewFrom(saved), revision: revisionOf(saved) };
  } catch (error) {
    return failure(error, "reply");
  }
}

/** NIHO に報告する, once per review: the review stays shown. `commandId` makes a retry the same report. */
export async function reportGuestReview(
  providerId: string,
  reviewId: string,
  report: { reason: HostReviewReportReason; note: string; commandId: string },
): Promise<HostActionResult<Saved>> {
  const owner = await asOwner(providerId, GUEST_REVIEW_REPORT_FAILED_TEXT);
  if (!owner.ok) return owner;
  try {
    const saved = await owner.store.reportReview(owner.actor, reviewId, { reason: REASON_TO_STORE[report.reason], note: report.note.trim() || null, commandId: report.commandId });
    return { ok: true, message: REVIEW_REPORTED_TEXT, review: hostReviewFrom(saved), revision: revisionOf(saved) };
  } catch (error) {
    return failure(error, "report");
  }
}
