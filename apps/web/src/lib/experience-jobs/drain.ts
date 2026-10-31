import "server-only";
import type { BookingCancellations, GuestBookingAccess, GuestBookingRepository, GuestMailOutbox, GuestQuestionRepository, GuestQuestionTranslations } from "@niho-experience/experience-store";
import { sendRefunds, type RefundSendDeps } from "@/lib/experience/booking-refunds";
import { bookingConfirmationEmail, bookingLinkEmail, bookingMessageEmail, bookingNoticeEmail, questionReplyEmail } from "@/lib/mail/templates";
import type { Mailer } from "@/lib/mail/transport";
import type { Translator } from "@/lib/translation/anthropic";
import { guestMessageToJapanese } from "@/lib/translation/prompts";

/**
 * One run of the experience mail job (#285 slices 5-7, docs/guest-booking.md, docs/guest-questions.md), every
 * minute from Cloud Scheduler: host replies to guest questions and host messages about bookings (#285 slice 6b), booking confirmations, the notices of
 * cancellations and refunds, the links "Find your booking" asked for, the refunds Stripe has not accepted (sent again,
 * #285 slice 7b), the Japanese of what guests wrote to hosts, then the erasure of guest data and questions a
 * year on and the removal of booking page links and sessions that ended. Each step is bounded and independent:
 * one that fails is reported and the next still runs. Counts only leave this module: never an address, a name,
 * a token or a message.
 */
export const EXPERIENCE_JOB_LIMITS = {
  /**
   * Emails a step sends in one run. Each is claimed just before it is sent, so its lease covers one send
   * (the SMTP timeouts are far shorter) and no email waits behind others while its lease runs out.
   */
  replies: 20,
  replyLeaseSeconds: 120,
  replyLinkTtlDays: 14,
  confirmations: 20,
  confirmationLeaseSeconds: 120,
  /** 取消と返金 (#285 slice 7): cancellation, refund and declined-request emails a run sends, as the confirmations. */
  notices: 20,
  noticeLeaseSeconds: 120,
  /** "Find your booking" (#285 slice 6): link emails a run sends, one claimed at a time like the confirmations. */
  bookingLinks: 20,
  bookingLinkLeaseSeconds: 120,
  /**
   * 返金の自動再送 (#285 slice 7b): refunds Stripe has not accepted that a run sends again, one claimed at a time. A
   * refund waits refundGraceSeconds after it was asked for, so the request's own send goes first. The lease is the
   * store's for support's 「もう一度送る」 too (BOOKING_CANCELLATION_LIMITS.refundSendLeaseSeconds: a test keeps them equal).
   */
  refunds: 10,
  refundGraceSeconds: 120,
  refundLeaseSeconds: 120,
  /** Ended booking page grants and sessions removed per run (each kind). */
  accessPurgedPerStep: 500,
  /** A step starts no new email after this long, so a run ends well within the minute before the next one. */
  sendBudgetMs: 40_000,
  /** Owner decision 2026-10-31 (#285): guest data and questions are kept for one year. */
  retentionDays: 365,
  erasedPerStep: 200,
  /** Guest messages translated per run, one claim at a time, within the run's translation budget. */
  translations: 10,
  translationLeaseSeconds: 120,
  /** One Claude API call; the job tries a failed message again later. */
  translationTimeoutMs: 30_000,
  /** No new translation starts after this much of the run, so a slow API cannot hold the job. */
  translationBudgetMs: 60_000,
} as const;

export interface QuestionReplyCounts {
  readonly claimed: number;
  readonly sent: number;
  readonly retried: number;
  readonly failed: number;
}

export interface BookingConfirmationCounts {
  readonly claimed: number;
  readonly sent: number;
  /** Nothing to send: the guest's details were erased or the booking is no longer confirmed. */
  readonly skipped: number;
  readonly retried: number;
  readonly failed: number;
  /** A last attempt whose lease ran out without a report, closed unsent. */
  readonly abandoned: number;
}

export interface TranslationCounts {
  readonly claimed: number;
  readonly translated: number;
  readonly retried: number;
  /** Given up after the last attempt: the host reads the guest's English. */
  readonly failed: number;
  /** Closed without a call: written in Japanese, already translated, or erased. */
  readonly closed: number;
  /** A last attempt whose lease ran out without a report, closed untranslated. */
  readonly abandoned: number;
}

/** The links "Find your booking" asked for: as the confirmations. */
export type BookingLinkCounts = BookingConfirmationCounts;
/** The notices of a cancellation, a refund done or a declined request: as the confirmations. */
export type BookingNoticeCounts = BookingConfirmationCounts;

/** The refunds Stripe had not accepted, sent again (#285 slice 7b). Counts only: no refund, booking or guest. */
export interface RefundResendCounts {
  readonly claimed: number;
  /** Stripe accepted it (pending, or already done). */
  readonly sent: number;
  /** Stripe refused it for good: the refund failed and shows to support. */
  readonly failed: number;
  /** Stripe could not be reached (or its answer not recorded): the step stops, and the refund is tried again later, up to a limit. */
  readonly retried: number;
}

/**
 * A step that is turned off: translation (EXPERIENCE_TRANSLATION_ENABLED; guest messages wait untranslated) or the
 * guest's booking page (EXPERIENCE_GUEST_BOOKING_ENABLED; link emails wait, confirmations go without the link), or the
 * resending of refunds (that flag, and the Stripe key; the refunds wait for the same command or support).
 */
export interface StepOff {
  readonly off: true;
}

export interface PurgeCounts {
  readonly purged: number;
}

export interface ErasureCounts {
  readonly erased: number;
}

/** A step that threw: what it did before is not reported, and the next step still runs. */
export interface FailedStep {
  readonly error: "unavailable";
}

export interface ExperienceJobCounts {
  readonly questionReplies: QuestionReplyCounts | FailedStep;
  readonly bookingConfirmations: BookingConfirmationCounts | FailedStep;
  readonly bookingNotices: BookingNoticeCounts | FailedStep;
  readonly bookingLinks: BookingLinkCounts | StepOff | FailedStep;
  readonly bookingRefunds: RefundResendCounts | StepOff | FailedStep;
  readonly guestTranslations: TranslationCounts | StepOff | FailedStep;
  readonly guestErasure: ErasureCounts | FailedStep;
  readonly questionErasure: ErasureCounts | FailedStep;
  readonly bookingAccessPurge: PurgeCounts | StepOff | FailedStep;
}

export interface ExperienceJobDeps {
  readonly questions: Pick<GuestQuestionRepository, "claimReplyDeliveries" | "recordReplyDelivery" | "eraseInactiveThreads">;
  readonly confirmations: Pick<GuestMailOutbox, "claimBookingConfirmations" | "completeBookingConfirmation" | "retryBookingConfirmation">;
  readonly bookingLinks: Pick<GuestMailOutbox, "claimBookingLinks" | "completeBookingLink" | "retryBookingLink">;
  readonly notices: Pick<GuestMailOutbox, "claimBookingNotices" | "completeBookingNotice" | "retryBookingNotice">;
  /**
   * The guest's booking page (#285 slice 6), or null while it is off: each email that links to it gets a fresh
   * one-time grant from here, built into the link's URL fragment.
   */
  readonly access: Pick<GuestBookingAccess, "issueBookingAccessGrant" | "purgeExpiredAccess"> | null;
  /**
   * The store and Stripe (the platform key) for the refunds a cancellation asked for that Stripe never accepted
   * (#285 slice 7b), or null while booking on this site is off or the key is missing.
   */
  readonly refunds: { readonly cancellations: Pick<BookingCancellations, "claimRefundsToSend" | "recordRefundSubmission">; readonly submit: NonNullable<RefundSendDeps["submit"]> } | null;
  readonly guests: Pick<GuestBookingRepository, "eraseGuestData">;
  readonly translations: Pick<GuestQuestionTranslations, "claimTranslations" | "recordTranslation" | "retryTranslation">;
  /** The Claude API, or null while translation is off. */
  readonly translator: Translator | null;
  readonly mailer: Mailer;
  /** SITE_URL: the origin of every link in the emails. */
  readonly siteUrl: string;
  readonly now: () => Date;
  /** Called once per failed step with the error's class name only (a database message can quote row values). */
  readonly onStepError?: (step: keyof ExperienceJobCounts, errorName: string) => void;
}

export const isFailedStep = (value: object): value is FailedStep => "error" in value;

async function step<K extends keyof ExperienceJobCounts>(
  deps: ExperienceJobDeps,
  name: K,
  work: () => Promise<Exclude<ExperienceJobCounts[K], FailedStep>>,
): Promise<ExperienceJobCounts[K]> {
  try {
    return await work();
  } catch (error) {
    deps.onStepError?.(name, error instanceof Error ? error.name : "unknown error");
    return { error: "unavailable" } as ExperienceJobCounts[K];
  }
}

/** Whether a step may start another email: under its count and its time budget. */
function mayContinue(deps: ExperienceJobDeps, startedAt: number, claimed: number, limit: number): boolean {
  return claimed < limit && deps.now().getTime() - startedAt < EXPERIENCE_JOB_LIMITS.sendBudgetMs;
}

/**
 * Host replies: the reply and a one-time link to answer it (the token in the URL fragment only), one claimed
 * at a time. A host message about a booking made on this site (#285 slice 6b) links to the booking page with a fresh
 * one-time grant instead (none while the page is off or can no longer be opened). A transient failure ends the step:
 * the server is struggling, and the rest waits for the next run.
 */
async function sendQuestionReplies(deps: ExperienceJobDeps): Promise<QuestionReplyCounts> {
  const startedAt = deps.now().getTime();
  let claimed = 0;
  let sent = 0;
  let retried = 0;
  let failed = 0;
  while (mayContinue(deps, startedAt, claimed, EXPERIENCE_JOB_LIMITS.replies)) {
    const [reply] = await deps.questions.claimReplyDeliveries({
      limit: 1,
      leaseSeconds: EXPERIENCE_JOB_LIMITS.replyLeaseSeconds,
      linkTtlDays: EXPERIENCE_JOB_LIMITS.replyLinkTtlDays,
    });
    if (!reply) break;
    claimed += 1;
    let email;
    if (reply.kind === "BOOKING") {
      // A grant per email: the raw token goes into this email's link only (#285 slice 6).
      const grant = deps.access ? await deps.access.issueBookingAccessGrant(reply.publicBookingId) : null;
      email = bookingMessageEmail(reply, { siteUrl: deps.siteUrl, bookingPageGrant: grant?.token ?? null });
    } else {
      email = questionReplyEmail({
        siteUrl: deps.siteUrl,
        guestName: reply.guestName,
        hostName: reply.hostDisplayName,
        experienceTitle: reply.experienceTitle,
        reply: reply.english,
        replyToken: reply.replyToken,
        linkTtlDays: EXPERIENCE_JOB_LIMITS.replyLinkTtlDays,
      });
    }
    const result = await deps.mailer.sendMail({ to: reply.guestEmail, ...email });
    const status = await deps.questions.recordReplyDelivery(reply.messageId, result.ok ? "SENT" : result.failure === "transient" ? "RETRY" : "FAILED");
    if (status === "SENT") sent += 1;
    else if (status === "FAILED") failed += 1;
    else retried += 1;
    if (!result.ok && result.failure === "transient") break;
  }
  return { claimed, sent, retried, failed };
}

/** Booking confirmations of guest bookings (`booking.confirmed`), one claimed at a time, as the replies. */
async function sendBookingConfirmations(deps: ExperienceJobDeps): Promise<BookingConfirmationCounts> {
  const startedAt = deps.now().getTime();
  let claimed = 0;
  let abandoned = 0;
  let sent = 0;
  let skipped = 0;
  let retried = 0;
  let failed = 0;
  while (mayContinue(deps, startedAt, claimed, EXPERIENCE_JOB_LIMITS.confirmations)) {
    const claim = await deps.confirmations.claimBookingConfirmations({
      limit: 1,
      leaseSeconds: EXPERIENCE_JOB_LIMITS.confirmationLeaseSeconds,
    });
    abandoned += claim.abandoned;
    const [confirmation] = claim.confirmations;
    if (!confirmation) break;
    claimed += 1;
    if (confirmation.email === null) {
      await deps.confirmations.completeBookingConfirmation(confirmation.id);
      skipped += 1;
      continue;
    }
    // A grant per email: the raw token goes into this email's link only (#285 slice 6).
    const grant = deps.access ? await deps.access.issueBookingAccessGrant(confirmation.email.publicBookingId) : null;
    const email = bookingConfirmationEmail(confirmation.email, { siteUrl: deps.siteUrl, now: deps.now(), bookingPageGrant: grant?.token ?? null });
    const result = await deps.mailer.sendMail({ to: confirmation.email.guestEmail, ...email });
    if (result.ok || result.failure === "permanent") {
      await deps.confirmations.completeBookingConfirmation(confirmation.id);
      if (result.ok) sent += 1;
      else failed += 1;
    } else {
      if (await deps.confirmations.retryBookingConfirmation(confirmation.id, confirmation.attempts) === "FAILED") failed += 1;
      else retried += 1;
      break;
    }
  }
  return { claimed, sent, skipped, retried, failed, abandoned };
}

/**
 * 取消と返金 (#285 slice 7): the guest's notices of a cancellation, a refund Stripe finished and a declined request, one
 * claimed at a time as the confirmations, each with a fresh link to the booking page while the page is on.
 */
async function sendBookingNotices(deps: ExperienceJobDeps): Promise<BookingNoticeCounts> {
  const startedAt = deps.now().getTime();
  const counts = { claimed: 0, sent: 0, skipped: 0, retried: 0, failed: 0, abandoned: 0 };
  while (mayContinue(deps, startedAt, counts.claimed, EXPERIENCE_JOB_LIMITS.notices)) {
    const claim = await deps.notices.claimBookingNotices({ limit: 1, leaseSeconds: EXPERIENCE_JOB_LIMITS.noticeLeaseSeconds });
    counts.abandoned += claim.abandoned;
    const [notice] = claim.notices;
    if (!notice) break;
    counts.claimed += 1;
    if (notice.email === null) {
      await deps.notices.completeBookingNotice(notice.id);
      counts.skipped += 1;
      continue;
    }
    const grant = deps.access ? await deps.access.issueBookingAccessGrant(notice.email.publicBookingId) : null;
    const email = bookingNoticeEmail(notice.email, { siteUrl: deps.siteUrl, bookingPageGrant: grant?.token ?? null });
    const result = await deps.mailer.sendMail({ to: notice.email.guestEmail, ...email });
    if (result.ok || result.failure === "permanent") {
      await deps.notices.completeBookingNotice(notice.id);
      if (result.ok) counts.sent += 1;
      else counts.failed += 1;
    } else {
      if (await deps.notices.retryBookingNotice(notice.id, notice.attempts) === "FAILED") counts.failed += 1;
      else counts.retried += 1;
      break;
    }
  }
  return counts;
}

/**
 * The links "Find your booking" asked for (#285 slice 6), one claimed at a time as the confirmations, each with a
 * fresh one-time grant. A booking whose page can no longer be opened (cancelled, erased, long over) gets nothing.
 */
async function sendBookingLinks(deps: ExperienceJobDeps, access: NonNullable<ExperienceJobDeps["access"]>): Promise<BookingLinkCounts> {
  const startedAt = deps.now().getTime();
  const counts = { claimed: 0, sent: 0, skipped: 0, retried: 0, failed: 0, abandoned: 0 };
  while (mayContinue(deps, startedAt, counts.claimed, EXPERIENCE_JOB_LIMITS.bookingLinks)) {
    const claim = await deps.bookingLinks.claimBookingLinks({ limit: 1, leaseSeconds: EXPERIENCE_JOB_LIMITS.bookingLinkLeaseSeconds });
    counts.abandoned += claim.abandoned;
    const [link] = claim.links;
    if (!link) break;
    counts.claimed += 1;
    const grant = link.email ? await access.issueBookingAccessGrant(link.email.publicBookingId) : null;
    if (!link.email || !grant) {
      await deps.bookingLinks.completeBookingLink(link.id);
      counts.skipped += 1;
      continue;
    }
    const email = bookingLinkEmail(link.email, { siteUrl: deps.siteUrl, bookingPageGrant: grant.token });
    const result = await deps.mailer.sendMail({ to: link.email.guestEmail, ...email });
    if (result.ok || result.failure === "permanent") {
      await deps.bookingLinks.completeBookingLink(link.id);
      if (result.ok) counts.sent += 1;
      else counts.failed += 1;
    } else {
      if (await deps.bookingLinks.retryBookingLink(link.id, link.attempts) === "FAILED") counts.failed += 1;
      else counts.retried += 1;
      break;
    }
  }
  return counts;
}

/**
 * 返金の自動再送 (#285 slice 7b): a cancellation commits its refund first and sends it after, so a send that never
 * reached Stripe (Stripe down, the process stopped) leaves a refund the guest was told had started. The store hands out
 * one that is old enough, not held and under its attempt limit, one claimed at a time; Stripe is asked by our refund ID
 * first and the create carries it as the idempotency key, so a send that ran twice still refunds once. When Stripe
 * cannot be reached the step stops for this run. A refund still unsent after the limit stays on support's list.
 */
async function resendRefunds(deps: ExperienceJobDeps, refunds: NonNullable<ExperienceJobDeps["refunds"]>): Promise<RefundResendCounts> {
  const startedAt = deps.now().getTime();
  const counts = { claimed: 0, sent: 0, failed: 0, retried: 0 };
  while (mayContinue(deps, startedAt, counts.claimed, EXPERIENCE_JOB_LIMITS.refunds)) {
    const [refund] = await refunds.cancellations.claimRefundsToSend({
      limit: 1,
      olderThanSeconds: EXPERIENCE_JOB_LIMITS.refundGraceSeconds,
      leaseSeconds: EXPERIENCE_JOB_LIMITS.refundLeaseSeconds,
    });
    if (!refund) break;
    counts.claimed += 1;
    const [result] = await sendRefunds([refund], { cancellations: refunds.cancellations, submit: refunds.submit });
    if (result?.status === "REQUESTED") {
      counts.retried += 1;
      break;
    }
    if (result?.status === "FAILED") counts.failed += 1;
    else counts.sent += 1;
  }
  return counts;
}

/**
 * What guests wrote to hosts, in Japanese: one message claimed right before its call, so each call has the
 * whole lease. A failed call puts the message back for later (2, 4, 8, 16 minutes; given up after 5 tries,
 * when the host reads the English). When the API cannot be reached the step stops for this run instead of
 * waiting out a timeout per message.
 */
async function translateGuestMessages(deps: ExperienceJobDeps, translator: Translator): Promise<TranslationCounts> {
  const started = deps.now().getTime();
  const counts = { claimed: 0, translated: 0, retried: 0, failed: 0, closed: 0, abandoned: 0 };
  while (counts.claimed < EXPERIENCE_JOB_LIMITS.translations && deps.now().getTime() - started < EXPERIENCE_JOB_LIMITS.translationBudgetMs) {
    const claim = await deps.translations.claimTranslations({ limit: 1, leaseSeconds: EXPERIENCE_JOB_LIMITS.translationLeaseSeconds });
    counts.closed += claim.closed;
    counts.abandoned += claim.abandoned;
    const [message] = claim.translations;
    if (!message) break;
    counts.claimed += 1;
    const result = await translator(guestMessageToJapanese(message.text));
    if (result.ok) {
      await deps.translations.recordTranslation(message.id, result.text);
      counts.translated += 1;
      continue;
    }
    if (await deps.translations.retryTranslation(message.id, message.attempts) === "FAILED") counts.failed += 1;
    else counts.retried += 1;
    if (result.failure === "unavailable") break;
  }
  return counts;
}

export async function runExperienceJobs(deps: ExperienceJobDeps): Promise<ExperienceJobCounts> {
  const questionReplies = await step(deps, "questionReplies", () => sendQuestionReplies(deps));
  const bookingConfirmations = await step(deps, "bookingConfirmations", () => sendBookingConfirmations(deps));
  const bookingNotices = await step(deps, "bookingNotices", () => sendBookingNotices(deps));
  const access = deps.access;
  const bookingLinks: ExperienceJobCounts["bookingLinks"] = access
    ? await step(deps, "bookingLinks", () => sendBookingLinks(deps, access))
    : { off: true };
  const refunds = deps.refunds;
  const bookingRefunds: ExperienceJobCounts["bookingRefunds"] = refunds
    ? await step(deps, "bookingRefunds", () => resendRefunds(deps, refunds))
    : { off: true };
  const translator = deps.translator;
  const guestTranslations: ExperienceJobCounts["guestTranslations"] = translator
    ? await step(deps, "guestTranslations", () => translateGuestMessages(deps, translator))
    : { off: true };
  const cutoff = () => new Date(deps.now().getTime() - EXPERIENCE_JOB_LIMITS.retentionDays * 86_400_000).toISOString();
  const guestErasure = await step(deps, "guestErasure", async () => ({
    erased: await deps.guests.eraseGuestData({ endedBefore: cutoff(), limit: EXPERIENCE_JOB_LIMITS.erasedPerStep }),
  }));
  const questionErasure = await step(deps, "questionErasure", async () => ({
    erased: await deps.questions.eraseInactiveThreads({ lastMessageBefore: cutoff(), limit: EXPERIENCE_JOB_LIMITS.erasedPerStep }),
  }));
  const bookingAccessPurge: ExperienceJobCounts["bookingAccessPurge"] = access
    ? await step(deps, "bookingAccessPurge", async () => ({ purged: await access.purgeExpiredAccess({ limit: EXPERIENCE_JOB_LIMITS.accessPurgedPerStep }) }))
    : { off: true };
  return { questionReplies, bookingConfirmations, bookingNotices, bookingLinks, bookingRefunds, guestTranslations, guestErasure, questionErasure, bookingAccessPurge };
}

/** True when the run did or failed anything worth a log line. */
export function experienceJobActivity(counts: ExperienceJobCounts): { failed: boolean; active: boolean } {
  const steps = Object.values(counts) as (object & Record<string, unknown>)[];
  const failed = steps.some(isFailedStep);
  const active = failed || steps.some((value) => ["claimed", "abandoned", "closed", "erased", "purged"].some((key) => typeof value[key] === "number" && (value[key] as number) > 0));
  return { failed, active };
}
