import "server-only";
import { BOOKING_ACCESS_LIMITS, GUEST_REVIEW_LIMITS, StoreConflictError, StoreNotFoundError, type BookingCancellations, type ExternalReservationGuests, type GuestBookingAccess, type GuestBookingRepository, type GuestMailOutbox, type GuestMeetingGuideRepository, type GuestQuestionRepository, type GuestQuestionTranslations, type GuestReviewRepository, type HostMailOutbox, type HostNotificationAddresses } from "@niho-experience/experience-store";
import { sendRefunds, type RefundSendDeps } from "@/lib/experience/booking-refunds";
import { hostPushEventFromOutbox } from "@/lib/host/push/outbox";
import type { HostPushKind } from "@/lib/host/push/payload";
import { hostAddressConfirmationEmail, hostBookingEmail } from "@/lib/mail/host-templates";
import { bookingConfirmationEmail, bookingLinkEmail, bookingMeetingGuideEmail, bookingMessageEmail, bookingNoticeEmail, questionReplyEmail, reviewInvitationEmail } from "@/lib/mail/templates";
import type { Mailer } from "@/lib/mail/transport";
import type { Translator } from "@/lib/translation/anthropic";
import { guestMessageToJapanese } from "@/lib/translation/prompts";

/**
 * One run of the experience mail job (#285 slices 5-7, docs/guest-booking.md, docs/guest-questions.md), every
 * minute from Cloud Scheduler: host replies to guest questions and host messages about bookings (#285 slice 6b), booking confirmations, the notices of
 * cancellations and refunds, the links "Find your booking" asked for, the refunds Stripe has not accepted (sent again,
 * #285 slice 7b), the Japanese of what guests wrote to hosts, then the erasure of guest data and questions a
 * year on (the guests of OTA bookings too, #194) and the removal of booking page links and sessions that ended. Hosts get their emails here too
 * (#194): the link that confirms a new address, and the emails about new, cancelled and moved bookings, then the addresses of those
 * whose access ended are deleted. Each step is bounded and independent:
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
  reviewInvitations: 20,
  reviewInvitationLeaseSeconds: 120,
  meetingGuides: 20,
  meetingGuideLeaseSeconds: 120,
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
  /** ホストへのメール (#194): booking emails and address confirmations a run sends, one claimed at a time as the guests'. */
  hostMails: 20,
  hostAddressConfirmations: 10,
  hostMailLeaseSeconds: 120,
  /** People whose access ended, their addresses deleted per run. */
  hostAddressesPurgedPerStep: 200,
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
/**
 * The hosts' emails about bookings and their address confirmations (#194): as the confirmations. Skipped: nothing to send
 * (no address, no longer the booking's person, turned off in 設定 › 通知, a day old, a request no longer open).
 */
export type HostMailCounts = BookingConfirmationCounts;
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
  readonly reviewInvitations?: BookingConfirmationCounts | FailedStep;
  readonly meetingGuides?: BookingConfirmationCounts | StepOff | FailedStep;
  readonly meetingGuideSnapshotPurge?: PurgeCounts | StepOff | FailedStep;
  readonly bookingLinks: BookingLinkCounts | StepOff | FailedStep;
  readonly bookingRefunds: RefundResendCounts | StepOff | FailedStep;
  readonly guestTranslations: TranslationCounts | StepOff | FailedStep;
  readonly guestErasure: ErasureCounts | FailedStep;
  /** The guest details OTA readers sent (#194), a year after the experience as this site's guests. */
  readonly otaGuestErasure: ErasureCounts | FailedStep;
  readonly questionErasure: ErasureCounts | FailedStep;
  readonly bookingAccessPurge: PurgeCounts | StepOff | FailedStep;
  /** ホストへのメール (#194): off while EXPERIENCE_HOST_MAIL_ENABLED is (the rows wait; the pushes are unaffected). */
  readonly hostAddressConfirmations: HostMailCounts | StepOff | FailedStep;
  readonly hostBookingMails: HostMailCounts | StepOff | FailedStep;
  /** The addresses of hosts with no membership or grant left (#194), deleted whatever the flag. */
  readonly hostAddressPurge: PurgeCounts | FailedStep;
}

export interface ExperienceJobDeps {
  readonly questions: Pick<GuestQuestionRepository, "claimReplyDeliveries" | "recordReplyDelivery" | "eraseInactiveThreads">;
  readonly confirmations: Pick<GuestMailOutbox, "claimBookingConfirmations" | "completeBookingConfirmation" | "retryBookingConfirmation">;
  readonly bookingLinks: Pick<GuestMailOutbox, "claimBookingLinks" | "completeBookingLink" | "retryBookingLink">;
  readonly notices: Pick<GuestMailOutbox, "claimBookingNotices" | "completeBookingNotice" | "retryBookingNotice">;
  /** Present only when reviews and attendance are enabled. */
  readonly reviewInvitations?: {
    readonly outbox: Pick<GuestMailOutbox, "claimReviewInvitations" | "completeReviewInvitation" | "retryReviewInvitation">;
    readonly reviews: Pick<GuestReviewRepository, "issueInvitation">;
  };
  readonly meetingGuides?: {
    readonly outbox: Pick<GuestMailOutbox, "claimMeetingGuideDayBefore" | "completeMeetingGuideDayBefore" | "retryMeetingGuideDayBefore">;
    readonly photos: { read(assetId: string): Promise<Uint8Array> };
  };
  readonly meetingGuideSnapshots?: Pick<GuestMeetingGuideRepository, "purgeEndedSnapshots">;
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
  /** OTA bookings' guest details (#194). Erased whatever their flag: what was kept while it was on still goes. */
  readonly otaGuests: Pick<ExternalReservationGuests, "eraseGuestDetails">;
  readonly translations: Pick<GuestQuestionTranslations, "claimTranslations" | "recordTranslation" | "retryTranslation">;
  /** The Claude API, or null while translation is off. */
  readonly translator: Translator | null;
  /**
   * ホストへのメール (#194), or null while EXPERIENCE_HOST_MAIL_ENABLED is off. `allowed` is 設定 › 通知 (#109) as the push job
   * reads it: the kinds that cannot be stopped always come.
   */
  readonly hostMail: {
    readonly outbox: Pick<HostMailOutbox, "claimBookingMails" | "completeBookingMail" | "retryBookingMail" | "claimAddressConfirmations" | "issueAddressConfirmationToken" | "completeAddressConfirmation" | "retryAddressConfirmation">;
    readonly allowed: (providerId: string, kind: HostPushKind) => Promise<boolean>;
  } | null;
  /** Deletes the addresses of hosts whose access ended (#194), whatever the flag: what was kept while it was on still goes. */
  readonly hostAddresses: Pick<HostNotificationAddresses, "purge">;
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

/** One thank-you email per ATTENDED mark. Recheck eligibility when issuing its token, after claiming. */
async function sendReviewInvitations(deps: ExperienceJobDeps, source: NonNullable<ExperienceJobDeps["reviewInvitations"]>): Promise<BookingConfirmationCounts> {
  const startedAt = deps.now().getTime();
  const counts = { claimed: 0, sent: 0, skipped: 0, retried: 0, failed: 0, abandoned: 0 };
  while (mayContinue(deps, startedAt, counts.claimed, EXPERIENCE_JOB_LIMITS.reviewInvitations)) {
    const claim = await source.outbox.claimReviewInvitations({ limit: 1, leaseSeconds: EXPERIENCE_JOB_LIMITS.reviewInvitationLeaseSeconds });
    counts.abandoned += claim.abandoned;
    const [row] = claim.invitations;
    if (!row) break;
    counts.claimed += 1;
    if (!row.email) {
      await source.outbox.completeReviewInvitation(row.id);
      counts.skipped += 1;
      continue;
    }
    let token: string;
    try {
      ({ token } = await source.reviews.issueInvitation({
        providerId: row.email.providerId, bookingId: row.email.bookingId, ttlDays: GUEST_REVIEW_LIMITS.invitationTtlDaysMax,
      }));
    } catch (error) {
      if (!(error instanceof StoreNotFoundError || error instanceof StoreConflictError)) throw error;
      await source.outbox.completeReviewInvitation(row.id);
      counts.skipped += 1;
      continue;
    }
    const mail = reviewInvitationEmail(row.email, { siteUrl: deps.siteUrl, token });
    const result = await deps.mailer.sendMail({ to: row.email.guestEmail, ...mail });
    if (result.ok || result.failure === "permanent") {
      await source.outbox.completeReviewInvitation(row.id);
      if (result.ok) counts.sent += 1;
      else counts.failed += 1;
    } else {
      if (await source.outbox.retryReviewInvitation(row.id, row.attempts) === "FAILED") counts.failed += 1;
      else counts.retried += 1;
      break;
    }
  }
  return counts;
}

/** A single private guide email per confirmed booking, with an attached photo and the booking's own page link. */
async function sendMeetingGuides(deps: ExperienceJobDeps, source: NonNullable<ExperienceJobDeps["meetingGuides"]>): Promise<BookingConfirmationCounts> {
  const startedAt = deps.now().getTime();
  const counts = { claimed: 0, sent: 0, skipped: 0, retried: 0, failed: 0, abandoned: 0 };
  while (mayContinue(deps, startedAt, counts.claimed, EXPERIENCE_JOB_LIMITS.meetingGuides)) {
    const claim = await source.outbox.claimMeetingGuideDayBefore({ limit: 1, leaseSeconds: EXPERIENCE_JOB_LIMITS.meetingGuideLeaseSeconds });
    counts.abandoned += claim.abandoned;
    const [row] = claim.guides;
    if (!row) break;
    counts.claimed += 1;
    if (!row.email || !deps.access) {
      await source.outbox.completeMeetingGuideDayBefore(row.id);
      counts.skipped += 1;
      continue;
    }
    let photo: Uint8Array;
    try {
      photo = await source.photos.read(row.email.photoAssetId);
      if (photo.byteLength === 0 || photo.byteLength > 10 * 1024 * 1024) throw new Error("Invalid meeting photo");
    } catch {
      if (await source.outbox.retryMeetingGuideDayBefore(row.id, row.attempts) === "FAILED") counts.failed += 1;
      else counts.retried += 1;
      break;
    }
    const grant = await deps.access.issueBookingAccessGrant(row.email.publicBookingId);
    if (!grant) {
      await source.outbox.completeMeetingGuideDayBefore(row.id);
      counts.skipped += 1;
      continue;
    }
    const email = bookingMeetingGuideEmail(row.email, { siteUrl: deps.siteUrl, bookingPageGrant: grant.token, photo });
    const result = await deps.mailer.sendMail({ to: row.email.guestEmail, ...email });
    if (result.ok || result.failure === "permanent") {
      await source.outbox.completeMeetingGuideDayBefore(row.id);
      if (result.ok) counts.sent += 1;
      else counts.failed += 1;
    } else {
      if (await source.outbox.retryMeetingGuideDayBefore(row.id, row.attempts) === "FAILED") counts.failed += 1;
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

type HostMail = NonNullable<ExperienceJobDeps["hostMail"]>;

/**
 * The link that makes a new address the one a host's emails go to (#194), one claimed at a time as the confirmations: the
 * one-time token is made right before the email goes out (only its digest is kept), so a resent email's link replaces the
 * earlier one. A request no longer open (used, cancelled, an hour old, access ended) sends nothing.
 */
async function sendHostAddressConfirmations(deps: ExperienceJobDeps, hostMail: HostMail): Promise<HostMailCounts> {
  const startedAt = deps.now().getTime();
  const counts = { claimed: 0, sent: 0, skipped: 0, retried: 0, failed: 0, abandoned: 0 };
  while (mayContinue(deps, startedAt, counts.claimed, EXPERIENCE_JOB_LIMITS.hostAddressConfirmations)) {
    const claim = await hostMail.outbox.claimAddressConfirmations({ limit: 1, leaseSeconds: EXPERIENCE_JOB_LIMITS.hostMailLeaseSeconds });
    counts.abandoned += claim.abandoned;
    const [row] = claim.confirmations;
    if (!row) break;
    counts.claimed += 1;
    const token = row.confirmation ? await hostMail.outbox.issueAddressConfirmationToken(row.confirmation.confirmationId) : null;
    if (!row.confirmation || !token) {
      await hostMail.outbox.completeAddressConfirmation(row.id);
      counts.skipped += 1;
      continue;
    }
    const email = hostAddressConfirmationEmail({ siteUrl: deps.siteUrl, token, expiresAt: row.confirmation.expiresAt });
    const result = await deps.mailer.sendMail({ to: row.confirmation.email, ...email });
    if (result.ok || result.failure === "permanent") {
      await hostMail.outbox.completeAddressConfirmation(row.id);
      if (result.ok) counts.sent += 1;
      else counts.failed += 1;
    } else {
      if (await hostMail.outbox.retryAddressConfirmation(row.id, row.attempts) === "FAILED") counts.failed += 1;
      else counts.retried += 1;
      break;
    }
  }
  return counts;
}

/**
 * A host's emails about bookings (#194, owner decision 2026-11-01): this site's new and cancelled bookings to the OWNER, an OTA
 * booking that is new, cancelled or moved to the product's OWNER and operators, each to the address in use when it goes. The
 * words are the push's (the same event, with an OTA guest's kept name read now), and so are the rules: a day old, a row of
 * another shape or a kind turned off in 設定 › 通知 is not sent. One claimed at a time, as the confirmations.
 */
async function sendHostBookingMails(deps: ExperienceJobDeps, hostMail: HostMail): Promise<HostMailCounts> {
  const startedAt = deps.now().getTime();
  const counts = { claimed: 0, sent: 0, skipped: 0, retried: 0, failed: 0, abandoned: 0 };
  while (mayContinue(deps, startedAt, counts.claimed, EXPERIENCE_JOB_LIMITS.hostMails)) {
    const claim = await hostMail.outbox.claimBookingMails({ limit: 1, leaseSeconds: EXPERIENCE_JOB_LIMITS.hostMailLeaseSeconds });
    counts.abandoned += claim.abandoned;
    const [row] = claim.mails;
    if (!row) break;
    counts.claimed += 1;
    const parsed = hostPushEventFromOutbox({
      id: row.id,
      providerId: row.providerId,
      topic: row.notificationTopic,
      payload: row.guestName === null ? row.payload : { ...row.payload, guestName: row.guestName },
      attempts: row.attempts,
      createdAt: row.createdAt,
    }, deps.now().getTime());
    if (!parsed.ok || row.to === null || !(await hostMail.allowed(row.providerId, parsed.event.kind))) {
      await hostMail.outbox.completeBookingMail(row.id);
      counts.skipped += 1;
      continue;
    }
    const email = hostBookingEmail(parsed.event, { siteUrl: deps.siteUrl });
    const result = await deps.mailer.sendMail({ to: row.to, ...email });
    if (result.ok || result.failure === "permanent") {
      await hostMail.outbox.completeBookingMail(row.id);
      if (result.ok) counts.sent += 1;
      else counts.failed += 1;
    } else {
      if (await hostMail.outbox.retryBookingMail(row.id, row.attempts) === "FAILED") counts.failed += 1;
      else counts.retried += 1;
      break;
    }
  }
  return counts;
}

export async function runExperienceJobs(deps: ExperienceJobDeps): Promise<ExperienceJobCounts> {
  const questionReplies = await step(deps, "questionReplies", () => sendQuestionReplies(deps));
  const bookingConfirmations = await step(deps, "bookingConfirmations", () => sendBookingConfirmations(deps));
  const meetingGuides = deps.meetingGuides
    ? await step(deps, "meetingGuides", () => sendMeetingGuides(deps, deps.meetingGuides!))
    : undefined;
  const bookingNotices = await step(deps, "bookingNotices", () => sendBookingNotices(deps));
  const reviewInvitations = deps.reviewInvitations
    ? await step(deps, "reviewInvitations", () => sendReviewInvitations(deps, deps.reviewInvitations!))
    : undefined;
  const hostMail = deps.hostMail;
  const hostAddressConfirmations: ExperienceJobCounts["hostAddressConfirmations"] = hostMail
    ? await step(deps, "hostAddressConfirmations", () => sendHostAddressConfirmations(deps, hostMail))
    : { off: true };
  const hostBookingMails: ExperienceJobCounts["hostBookingMails"] = hostMail
    ? await step(deps, "hostBookingMails", () => sendHostBookingMails(deps, hostMail))
    : { off: true };
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
  const otaGuestErasure = await step(deps, "otaGuestErasure", async () => ({
    erased: await deps.otaGuests.eraseGuestDetails({ endedBefore: cutoff(), limit: EXPERIENCE_JOB_LIMITS.erasedPerStep }),
  }));
  const questionErasure = await step(deps, "questionErasure", async () => ({
    erased: await deps.questions.eraseInactiveThreads({ lastMessageBefore: cutoff(), limit: EXPERIENCE_JOB_LIMITS.erasedPerStep }),
  }));
  const bookingAccessPurge: ExperienceJobCounts["bookingAccessPurge"] = access
    ? await step(deps, "bookingAccessPurge", async () => ({ purged: await access.purgeExpiredAccess({ limit: EXPERIENCE_JOB_LIMITS.accessPurgedPerStep }) }))
    : { off: true };
  const meetingGuideSnapshotPurge: ExperienceJobCounts["meetingGuideSnapshotPurge"] = deps.meetingGuideSnapshots
    ? await step(deps, "meetingGuideSnapshotPurge", async () => ({
      purged: await deps.meetingGuideSnapshots!.purgeEndedSnapshots({
        endedBefore: new Date(deps.now().getTime() - BOOKING_ACCESS_LIMITS.daysAfterExperience * 86_400_000).toISOString(),
        limit: EXPERIENCE_JOB_LIMITS.accessPurgedPerStep,
      }),
    }))
    : undefined;
  const hostAddressPurge = await step(deps, "hostAddressPurge", async () => ({
    purged: await deps.hostAddresses.purge({ limit: EXPERIENCE_JOB_LIMITS.hostAddressesPurgedPerStep }),
  }));
  return {
    questionReplies, bookingConfirmations, bookingNotices, bookingLinks, bookingRefunds, guestTranslations, guestErasure, otaGuestErasure, questionErasure,
    bookingAccessPurge, hostAddressConfirmations, hostBookingMails, hostAddressPurge,
    ...(meetingGuideSnapshotPurge ? { meetingGuideSnapshotPurge } : {}),
    ...(reviewInvitations ? { reviewInvitations } : {}),
    ...(meetingGuides ? { meetingGuides } : {}),
  };
}

/** True when the run did or failed anything worth a log line. */
export function experienceJobActivity(counts: ExperienceJobCounts): { failed: boolean; active: boolean } {
  const steps = Object.values(counts) as (object & Record<string, unknown>)[];
  const failed = steps.some(isFailedStep);
  const active = failed || steps.some((value) => ["claimed", "abandoned", "closed", "erased", "purged"].some((key) => typeof value[key] === "number" && (value[key] as number) > 0));
  return { failed, active };
}
