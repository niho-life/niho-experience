"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { draftReviewReplyEnglish } from "@/host/actions";
import { guestMessageView } from "@/host/messages";
import type { HostNotice } from "@/host/payout";
import { publishGuestReviewReply, reportGuestReview } from "@/host/review-actions";
import {
  publishReviewReply,
  ratingLabel,
  replyDates,
  replyDraftFrom,
  reportReview,
  REVIEW_REPLY_TEXT_LIMIT,
  REVIEW_REPORT_NOTE_LIMIT,
  REVIEW_REPORT_REASONS,
  REVIEW_REPORTED_TEXT,
  REVIEW_WAITING_TEXT,
  reviewAnchor,
  reviewerLabel,
  reviewIdFromHash,
  reviewReplyDraftState,
  reviewReplyStage,
  reviewSessionLabel,
  reviewsHref,
  reviewsOf,
  reviewSummary,
  reviewSummaryNotes,
  reviewTagLabels,
  sortReviews,
} from "@/host/reviews";
import { REVIEW_STATUS } from "@/host/status";
import type { HostReview, HostReviewReportReason, HostReviewText } from "@/host/types";
import { HOST_HOME_PATH, withProvider } from "@/lib/host/routes";
import { DISABLED, FIELD_LABEL, useFocusAfterRender } from "./editor-parts";
import { TEXTAREA } from "./fields";
import { CHOICE, CHOICE_INPUT, GROUP_LABEL } from "./HostBookingDialogs";
import { HostConfirmDialog } from "./HostConfirmDialog";
import { HostIcon } from "./HostIcon";
import { HostNoticeLine } from "./HostNoticeLine";
import { HostSubHeader } from "./HostSubHeader";
import { consoleButtonClass, HOST_SURFACE } from "./host-ui";
import { replySignature, reportSignature, reviewAttempt, withRevision, withSavedReview, type ReviewAttempt, type ReviewWrite } from "./live-review-state";
import { ReplyDraftFields, useReplyDraft } from "./ReplyDraftFields";
import { HostPageBody, InitialAvatar, PageHead, RatingStars, StatusPill } from "./ui";

/**
 * The reviewer's name is the review's anchor (`#review-{id}`) and takes focus: a fragment that
 * names an element that cannot take focus makes the browser move focus away to the page.
 */
const headingId = (id: string) => reviewAnchor(id);
const replyHeadingId = (id: string) => `${reviewAnchor(id)}-reply`;
const replyButtonId = (id: string) => `${reviewAnchor(id)}-reply-button`;
const SMALL_HEADING = "font-sans text-xs leading-normal font-extrabold tracking-normal";

/** What a guest wrote: NIHO's translation with their own words under it, or their words alone (and why). */
function ReviewText({ text }: { text: HostReviewText }) {
  const view = guestMessageView(text);
  return (
    <>
      <p lang={view.lang} className="whitespace-pre-wrap [overflow-wrap:anywhere]">
        {view.text}
      </p>
      {view.original ? (
        <p lang={text.language} className="mt-1.5 text-[0.8125rem] leading-[1.55] whitespace-pre-wrap text-muted [overflow-wrap:anywhere]">
          <span lang="ja" className="sr-only">
            原文：
          </span>
          {view.original}
        </p>
      ) : null}
      {view.note ? (
        <p className="mt-1.5 text-xs leading-normal">
          <span className={`inline-flex items-center rounded-full px-2 font-extrabold ${view.untranslated ? "bg-warn-pale text-warn" : "bg-info-pale text-info"}`}>{view.note}</span>
        </p>
      ) : null}
    </>
  );
}

/** The host's published reply: the Japanese they wrote, the English the page shows behind 公開した英語, and when. */
function PublishedReply({ review }: { review: HostReview }) {
  const reply = review.reply;
  if (!reply) return null;
  const dates = replyDates(reply);
  return (
    <div className="mt-3 border-l-[3px] border-leaf pl-3 text-[0.84375rem] leading-[1.55]">
      <h3 id={replyHeadingId(review.id)} tabIndex={-1} className={`${SMALL_HEADING} text-ink-soft focus:outline-none`}>
        あなたの返信
      </h3>
      {reply.japanese ? (
        <>
          <p className="mt-0.5 whitespace-pre-wrap [overflow-wrap:anywhere]">{reply.japanese}</p>
          <details className="group mt-1.5">
            <summary className="inline-flex cursor-pointer list-none items-center gap-0.5 text-xs font-extrabold text-moss [&::-webkit-details-marker]:hidden">
              公開した英語
              <HostIcon name="chevronDown" className="size-3.5 group-open:rotate-180" />
            </summary>
            <p lang="en" className="mt-1 whitespace-pre-wrap text-ink-soft [overflow-wrap:anywhere]">
              {reply.english}
            </p>
          </details>
        </>
      ) : (
        <p lang="en" className="mt-0.5 whitespace-pre-wrap [overflow-wrap:anywhere]">
          {reply.english}
        </p>
      )}
      <p className="mt-1 text-xs leading-normal text-muted">{[dates.published, dates.edited].filter(Boolean).join(" · ")}</p>
    </div>
  );
}

export interface ReplyInput {
  japanese: string;
  english: string;
}

/**
 * 返信する / 返信を直す: 日本語で書く → 英語にする → "公開される英語" (英語を作り直す / 英語を直す)
 * → 返信を公開する. A correction starts from the published reply and waits for a change. Hidden
 * (not dropped) while another review's reply is open, so the Japanese written so far stays; so
 * does a reply the store could not take (`busy` while it is sent, live).
 */
function ReviewReplyComposer({ review, providerId, hidden, busy, onPublish, onCancel }: { review: HostReview; providerId: string; hidden: boolean; busy: boolean; onPublish: (reply: ReplyInput) => void; onCancel: () => void }) {
  const japaneseField = useRef<HTMLTextAreaElement>(null);
  const published = review.reply;
  const draft = useReplyDraft((japanese) => draftReviewReplyEnglish({ providerId, reviewId: review.id, japanese }), { initial: published ? replyDraftFrom(published) : undefined });
  const { canSend, unchanged } = reviewReplyDraftState(draft, published);

  // Opened (again): the Japanese is where the host goes on.
  useEffect(() => {
    if (!hidden) japaneseField.current?.focus();
  }, [hidden]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSend || draft.drafting || busy) return;
    onPublish({ japanese: draft.japanese, english: draft.english });
  };

  return (
    <form onSubmit={submit} hidden={hidden} aria-label={`${review.reviewer.name} さんへの返信`} aria-busy={busy || undefined} className="mt-3 border-t border-dashed border-line-strong pt-3">
      <ReplyDraftFields
        draft={draft}
        japaneseRef={japaneseField}
        maxLength={REVIEW_REPLY_TEXT_LIMIT}
        englishLabel="公開される英語"
        submitLabel={busy ? "公開しています…" : "返信を公開する"}
        canSubmit={canSend && !busy}
        extra={
          <button type="button" onClick={onCancel} disabled={busy} className={consoleButtonClass("ghost", "md")}>
            やめる
          </button>
        }
      />
      <p className="mt-2 text-xs leading-normal text-muted">{unchanged ? "日本語か英語を直すと公開できます" : "返信は体験のページに英語で公開されます"}</p>
    </form>
  );
}

/**
 * NIHO に報告する: the reason first (個人情報・事実と違う・不適切・その他) and, if the host wants,
 * a word for NIHO. The review stays as it is until NIHO decides. Nothing happens until its own
 * button is pressed; it waits for a reason.
 */
function ReviewReportDialog({ review, onConfirm, onClose }: { review: HostReview; onConfirm: (reason: HostReviewReportReason, note: string) => void; onClose: () => void }) {
  const baseId = useId();
  const [reason, setReason] = useState<HostReviewReportReason | null>(null);
  const [note, setNote] = useState("");
  const first = useRef<HTMLInputElement>(null);
  const hintId = `${baseId}-waiting`;
  return (
    <HostConfirmDialog
      title="このレビューを NIHO に報告しますか？"
      description={`${reviewerLabel(review)} のレビューを NIHO が確認します。報告してもレビューは隠れません。どうするかは NIHO が決めます。`}
      focusRef={first}
      hint={
        reason ? null : (
          <p id={hintId} className="basis-full text-xs text-muted">
            理由を選ぶと報告できます
          </p>
        )
      }
      confirm={
        <button type="submit" disabled={!reason} aria-describedby={reason ? undefined : hintId} className={consoleButtonClass("primary", "md", DISABLED)}>
          NIHO に報告する
        </button>
      }
      onConfirm={() => {
        if (reason) onConfirm(reason, note.trim());
      }}
      onClose={onClose}
    >
      <fieldset className="mt-4 min-w-0">
        <legend className={GROUP_LABEL}>報告の理由</legend>
        <div className="flex flex-wrap gap-2">
          {REVIEW_REPORT_REASONS.map((item, index) => (
            <label key={item.value} className={`${CHOICE} inline-flex min-h-9 items-center rounded-full px-3.5 py-1 text-[0.8125rem] font-extrabold`}>
              <input
                ref={index === 0 ? first : undefined}
                type="radio"
                name={`${baseId}-reason`}
                value={item.value}
                checked={reason === item.value}
                onChange={() => setReason(item.value)}
                className={`${CHOICE_INPUT} rounded-full`}
              />
              {item.label}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="mt-4 flex flex-col gap-1.5">
        <label htmlFor={`${baseId}-note`} className={FIELD_LABEL}>
          ひとこと（任意）
        </label>
        <textarea id={`${baseId}-note`} rows={3} maxLength={REVIEW_REPORT_NOTE_LIMIT} value={note} onChange={(event) => setNote(event.currentTarget.value)} className={TEXTAREA} />
      </div>
    </HostConfirmDialog>
  );
}

interface ReviewRowProps {
  review: HostReview;
  hidden: boolean;
  experienceTitle: string;
  providerId: string;
  /** This review's reply was opened and is kept (hidden while another one is open). */
  kept: boolean;
  /** …and it is the one shown. */
  composing: boolean;
  /** Live: its reply or report is with the store. */
  busy: ReviewWrite | null;
  notice: HostNotice | null;
  onReply: () => void;
  onCancel: () => void;
  onPublish: (reply: ReplyInput) => void;
  onReport: () => void;
}

/**
 * One review: who and where from, the session and the stars, its state (公開前), the good points,
 * the guest's words (translated, with the original), the note for the host, the reply (or why
 * there is none yet) and 報告する.
 */
function ReviewRow({ review, hidden, experienceTitle, providerId, kept, composing, busy, notice, onReply, onCancel, onPublish, onReport }: ReviewRowProps) {
  const stage = reviewReplyStage(review);
  const tags = reviewTagLabels(review.tags);
  return (
    <li hidden={hidden} className="border-t border-line px-4 py-4 first:border-t-0 md:px-5">
      <div className="flex items-start gap-3">
        <InitialAvatar name={review.reviewer.name} className="mt-0.5 size-9 text-[0.875rem]" />
        <div className="min-w-0 flex-1 text-[0.875rem] leading-[1.6]">
          <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5">
            <div className="min-w-0 flex-[1_1_180px]">
              <h2 id={headingId(review.id)} tabIndex={-1} className="scroll-mt-20 font-sans text-[0.9375rem] leading-[1.4] font-extrabold tracking-normal [overflow-wrap:anywhere] focus:outline-none">
                {reviewerLabel(review)}
              </h2>
              <p className="text-[0.78125rem] leading-normal text-muted [overflow-wrap:anywhere]">
                {reviewSessionLabel(review, experienceTitle)} · <RatingStars rating={review.rating} label={ratingLabel(review.rating)} />
              </p>
            </div>
            {review.status === "pending" ? <StatusPill status={REVIEW_STATUS.pending} /> : null}
          </div>

          {tags.length ? (
            <ul aria-label="よかった点" className="mt-2 flex flex-wrap gap-1.5">
              {tags.map((tag) => (
                <li key={tag} className="inline-flex h-6 items-center rounded-full bg-sand px-2.5 text-xs font-extrabold text-ink-soft">
                  {tag}
                </li>
              ))}
            </ul>
          ) : null}

          <div className="mt-2.5">
            <ReviewText text={review.body} />
          </div>

          {review.privateNote ? (
            <div className="mt-3 rounded-xl bg-leaf-pale px-3 py-2.5 text-[0.8125rem] leading-[1.55]">
              <h3 className={`${SMALL_HEADING} mb-0.5 text-moss`}>あなただけへのメモ</h3>
              <ReviewText text={review.privateNote} />
            </div>
          ) : null}

          {stage === "replied" && !composing ? <PublishedReply review={review} /> : null}
          {kept ? <ReviewReplyComposer review={review} providerId={providerId} hidden={!composing} busy={busy === "reply"} onPublish={onPublish} onCancel={onCancel} /> : null}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {stage === "waiting" ? (
              <p className="min-w-0 flex-[1_1_200px] text-[0.78125rem] leading-normal text-muted">{REVIEW_WAITING_TEXT}</p>
            ) : composing ? null : (
              <button id={replyButtonId(review.id)} type="button" aria-describedby={headingId(review.id)} onClick={onReply} className={consoleButtonClass("secondary", "sm")}>
                {stage === "replied" ? "返信を直す" : "返信する"}
              </button>
            )}
            {review.report ? (
              <span className="ml-auto inline-flex min-h-[30px] items-center gap-1 text-xs font-extrabold text-muted">
                <HostIcon name="check" className="size-3.5" />
                報告済み
              </span>
            ) : (
              <button type="button" aria-describedby={headingId(review.id)} onClick={onReport} disabled={busy !== null} className={consoleButtonClass("ghost", "sm", "ml-auto")}>
                {busy === "report" ? "報告しています…" : "報告する"}
              </button>
            )}
          </div>
          <HostNoticeLine notice={notice} className="mt-2" />
        </div>
      </div>
    </li>
  );
}

export interface HostReviewsProps {
  reviews: readonly HostReview[];
  /** The provider's experiences, for the select and each review's session line. */
  experiences: readonly { id: string; title: string }[];
  /** The moment a reply or a report is dated with (YYYY-MM-DDTHH:MM, JST; the preview's fixed one in mock mode). */
  now: string;
  /** The URL's own `?providerId=` (when well formed), carried on every link. */
  linkProviderId: string | null;
  /** The provider shown: 英語にする asks NIHO for its reviews. */
  providerId: string;
  /**
   * Reviews kept in the experience DB (#108, http mode): each is published when written (none is
   * 公開前, so every one takes a reply); a reply and a report go to the store, and the review it
   * answers replaces the one on the screen. `revisions` holds each review's reply revision (0: none
   * yet), which a correction is checked against. Absent in mock mode.
   */
  live?: { revisions: Readonly<Record<string, number>> } | null;
}

const LIVE_FAILED: Record<ReviewWrite, string> = {
  reply: "返信を公開できませんでした。時間をおいて、もう一度お試しください。",
  report: "報告できませんでした。時間をおいて、もう一度お試しください。",
};

/**
 * レビュー (#108, the journey mock's H4): every review of the provider's experiences, the newest
 * first, with the published ones' average on top; one experience's with `?experience=` (a select
 * from two experiences). A screen under ホーム (PC: ホーム selected; phones: "‹ ホーム", no bottom
 * tabs). `#review-{id}` (ホーム's rows) scrolls to one review and focuses its name.
 *
 * Mock mode: a reply and a report change this screen only (the preview note says nothing is kept).
 * Reviews kept in the experience DB (`live`, #108) send them to the store and show the review it
 * reads back; one that fails keeps what the host wrote and says why.
 */
export function HostReviews({ reviews: initialReviews, experiences, now, linkProviderId, providerId, live = null }: HostReviewsProps) {
  const searchParams = useSearchParams();
  const [reviews, setReviews] = useState<readonly HostReview[]>(initialReviews);
  /** The reviews whose reply was opened and is kept, and the one shown: one at a time. */
  const [drafts, setDrafts] = useState<readonly string[]>([]);
  const [composing, setComposing] = useState<string | null>(null);
  const [notices, setNotices] = useState<Readonly<Record<string, HostNotice | null>>>({});
  const [reporting, setReporting] = useState<HostReview | null>(null);
  /** Live: each reply's revision, what is with the store (by review), and the command id of each try. */
  const [revisions, setRevisions] = useState<Readonly<Record<string, number>>>(live?.revisions ?? {});
  const [busy, setBusy] = useState<Readonly<Record<string, ReviewWrite>>>({});
  const sending = useRef<Set<string>>(new Set());
  const attempts = useRef<Map<string, ReviewAttempt>>(new Map());
  const focusLater = useFocusAfterRender();

  const requested = searchParams.get("experience");
  const experienceId = experiences.some((experience) => experience.id === requested) ? requested : null;
  const shown = sortReviews(reviewsOf(reviews, experienceId));
  const allReviews = sortReviews(reviews);
  const summary = reviewSummary(shown);
  const notes = reviewSummaryNotes(summary);
  const titleOf = (id: string) => experiences.find((experience) => experience.id === id)?.title ?? "";

  // ホーム's "読んで返信する" leads to one review: its name takes focus (and the screen scrolls there).
  useEffect(() => {
    const focusRequested = () => {
      const id = reviewIdFromHash(window.location.hash);
      if (id) document.getElementById(headingId(id))?.focus();
    };
    focusRequested();
    window.addEventListener("hashchange", focusRequested);
    return () => window.removeEventListener("hashchange", focusRequested);
  }, []);

  // Functional updates: a live answer arrives after other changes on the screen.
  const replace = (updated: HostReview) => setReviews((current) => withSavedReview(current, updated));
  const say = (id: string, text: string) => setNotices((current) => ({ ...current, [id]: text ? { tone: "success", message: text } : null }));
  const fail = (id: string, text: string) => setNotices((current) => ({ ...current, [id]: { tone: "error", message: text } }));
  const drop = (id: string) => {
    setDrafts((current) => current.filter((draft) => draft !== id));
    setComposing((current) => (current === id ? null : current));
  };

  const reply = (id: string) => {
    setDrafts((current) => (current.includes(id) ? current : [...current, id]));
    setComposing(id);
    say(id, "");
  };

  /** やめる: the reply written so far goes; focus is back on the button that opened it. */
  const cancel = (id: string) => {
    drop(id);
    focusLater(replyButtonId(id));
  };

  /**
   * Live: one reply or report with the store at a time per review. The same try again (a failure
   * retried as it was) keeps its command id, so the store takes it once. Null when it failed.
   */
  const sendLive = async <T,>(review: HostReview, write: ReviewWrite, signature: string, run: (commandId: string) => Promise<T>): Promise<T | null> => {
    if (sending.current.has(review.id)) return null;
    const key = `${write}:${review.id}`;
    const attempt = reviewAttempt(attempts.current.get(key), signature, () => crypto.randomUUID());
    attempts.current.set(key, attempt);
    sending.current.add(review.id);
    setBusy((current) => ({ ...current, [review.id]: write }));
    say(review.id, "");
    try {
      return await run(attempt.commandId);
    } catch {
      fail(review.id, LIVE_FAILED[write]);
      return null;
    } finally {
      sending.current.delete(review.id);
      setBusy((current) => Object.fromEntries(Object.entries(current).filter(([id]) => id !== review.id)));
    }
  };

  /** Live: the review the store answered, and its reply revision for the next correction. */
  const settle = (write: ReviewWrite, saved: { review: HostReview; revision: number }) => {
    attempts.current.delete(`${write}:${saved.review.id}`);
    replace(saved.review);
    setRevisions((current) => withRevision(current, saved.review.id, saved.revision));
  };

  const publishLive = async (review: HostReview, input: ReplyInput) => {
    const result = await sendLive(review, "reply", replySignature(review.id, input), (commandId) =>
      publishGuestReviewReply({ providerId, reviewId: review.id, japanese: input.japanese, english: input.english, commandId, expectedRevision: revisions[review.id] ?? 0 }),
    );
    if (!result) return;
    if (!result.ok) {
      // What the host wrote stays on the screen.
      fail(review.id, result.message);
      return;
    }
    settle("reply", result);
    drop(review.id);
    say(review.id, result.message);
    focusLater(replyHeadingId(review.id));
  };

  /** The dialog closes at once: the review's name takes focus, and the line under it says how the report went. */
  const reportLive = async (review: HostReview, reason: HostReviewReportReason, note: string) => {
    focusLater(headingId(review.id));
    const result = await sendLive(review, "report", reportSignature(review.id, reason, note), (commandId) => reportGuestReview({ providerId, reviewId: review.id, reason, note, commandId }));
    if (!result) return;
    if (!result.ok) {
      fail(review.id, result.message);
      return;
    }
    settle("report", result);
    say(review.id, result.message);
  };

  const publish = (review: HostReview, input: ReplyInput) => {
    if (live) {
      void publishLive(review, input);
      return;
    }
    const updated = publishReviewReply(review, input, now);
    if (updated === review) return;
    replace(updated);
    drop(review.id);
    say(review.id, review.reply ? "返信を直しました" : "返信を公開しました");
    focusLater(replyHeadingId(review.id));
  };

  // Mock mode keeps the report on this screen.
  const report = (review: HostReview, reason: HostReviewReportReason, note: string) => {
    if (live) {
      void reportLive(review, reason, note);
      return;
    }
    replace(reportReview(review, reason, now, note));
    say(review.id, REVIEW_REPORTED_TEXT);
    focusLater(headingId(review.id));
  };

  return (
    <>
      <HostSubHeader backHref={withProvider(HOST_HOME_PATH, linkProviderId)} backLabel="ホーム" title="" />
      <HostPageBody>
        <PageHead title="レビュー">
          {summary.average ? (
            <p className="text-[0.9375rem] leading-normal font-extrabold whitespace-nowrap tabular-nums">
              <span aria-hidden="true">★ </span>
              <span className="sr-only">平均 </span>
              {summary.average}
              <span className="sr-only"> 点</span> · 公開 {summary.published} 件
            </p>
          ) : null}
        </PageHead>

        {experiences.length > 1 || notes.length ? (
          <div className="mb-3.5 flex flex-wrap items-center gap-x-4 gap-y-2">
            {experiences.length > 1 ? (
              <select
                aria-label="体験"
                value={experienceId ?? ""}
                onChange={(event) => window.history.pushState(null, "", reviewsHref({ providerId: linkProviderId, experience: event.currentTarget.value || null }))}
                className="block min-h-10 w-auto max-w-full min-w-0 rounded-[10px] border border-line-strong bg-canvas py-2 pr-2 pl-3 text-[1rem] leading-normal text-ink md:max-w-[300px] md:text-[0.875rem]"
              >
                <option value="">すべての体験</option>
                {experiences.map((experience) => (
                  <option key={experience.id} value={experience.id}>
                    {experience.title}
                  </option>
                ))}
              </select>
            ) : null}
            {notes.length ? (
              <ul aria-label="レビューの要約" className="flex flex-wrap gap-x-3 gap-y-1 text-[0.78125rem] leading-normal text-muted">
                {notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        <section aria-label="レビューの一覧" className={HOST_SURFACE}>
          {allReviews.length ? (
            <ul>
              {allReviews.map((review) => (
                <ReviewRow
                  key={review.id}
                  review={review}
                  hidden={!!experienceId && review.experienceId !== experienceId}
                  experienceTitle={titleOf(review.experienceId)}
                  providerId={providerId}
                  kept={drafts.includes(review.id)}
                  composing={composing === review.id}
                  busy={busy[review.id] ?? null}
                  notice={notices[review.id] ?? null}
                  onReply={() => reply(review.id)}
                  onCancel={() => cancel(review.id)}
                  onPublish={(input) => publish(review, input)}
                  onReport={() => setReporting(review)}
                />
              ))}
            </ul>
          ) : null}
          {!shown.length ? (
            <p className="px-4 py-6 text-muted md:px-5">レビューはまだありません</p>
          ) : null}
        </section>
      </HostPageBody>
      {reporting ? <ReviewReportDialog review={reporting} onConfirm={(reason, note) => report(reporting, reason, note)} onClose={() => setReporting(null)} /> : null}
    </>
  );
}
