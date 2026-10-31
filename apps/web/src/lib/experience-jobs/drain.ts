import "server-only";
import type { GuestBookingRepository, GuestMailOutbox, GuestQuestionRepository } from "@niho-experience/experience-store";
import { bookingConfirmationEmail, questionReplyEmail } from "@/lib/mail/templates";
import type { Mailer } from "@/lib/mail/transport";

/**
 * One run of the experience mail job (#285 slice 5, docs/guest-booking.md, docs/guest-questions.md), every
 * minute from Cloud Scheduler: host replies to guest questions, booking confirmations, then the erasure of
 * guest data and questions a year on. Each step is bounded and independent: one that fails is reported and
 * the next still runs. Counts only leave this module: never an address, a name, a token or a message.
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
  /** A step starts no new email after this long, so a run ends well within the minute before the next one. */
  sendBudgetMs: 40_000,
  /** Owner decision 2026-10-31 (#285): guest data and questions are kept for one year. */
  retentionDays: 365,
  erasedPerStep: 200,
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
  readonly guestErasure: ErasureCounts | FailedStep;
  readonly questionErasure: ErasureCounts | FailedStep;
}

export interface ExperienceJobDeps {
  readonly questions: Pick<GuestQuestionRepository, "claimReplyDeliveries" | "recordReplyDelivery" | "eraseInactiveThreads">;
  readonly confirmations: Pick<GuestMailOutbox, "claimBookingConfirmations" | "completeBookingConfirmation" | "retryBookingConfirmation">;
  readonly guests: Pick<GuestBookingRepository, "eraseGuestData">;
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
 * at a time. A transient failure ends the step: the server is struggling, and the rest waits for the next run.
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
    const email = questionReplyEmail({
      siteUrl: deps.siteUrl,
      guestName: reply.guestName,
      hostName: reply.hostDisplayName,
      experienceTitle: reply.experienceTitle,
      reply: reply.english,
      replyToken: reply.replyToken,
      linkTtlDays: EXPERIENCE_JOB_LIMITS.replyLinkTtlDays,
    });
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
    const email = bookingConfirmationEmail(confirmation.email, { siteUrl: deps.siteUrl, now: deps.now() });
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

export async function runExperienceJobs(deps: ExperienceJobDeps): Promise<ExperienceJobCounts> {
  const questionReplies = await step(deps, "questionReplies", () => sendQuestionReplies(deps));
  const bookingConfirmations = await step(deps, "bookingConfirmations", () => sendBookingConfirmations(deps));
  const cutoff = () => new Date(deps.now().getTime() - EXPERIENCE_JOB_LIMITS.retentionDays * 86_400_000).toISOString();
  const guestErasure = await step(deps, "guestErasure", async () => ({
    erased: await deps.guests.eraseGuestData({ endedBefore: cutoff(), limit: EXPERIENCE_JOB_LIMITS.erasedPerStep }),
  }));
  const questionErasure = await step(deps, "questionErasure", async () => ({
    erased: await deps.questions.eraseInactiveThreads({ lastMessageBefore: cutoff(), limit: EXPERIENCE_JOB_LIMITS.erasedPerStep }),
  }));
  return { questionReplies, bookingConfirmations, guestErasure, questionErasure };
}

/** True when the run did or failed anything worth a log line. */
export function experienceJobActivity(counts: ExperienceJobCounts): { failed: boolean; active: boolean } {
  const steps = Object.values(counts) as (object & Record<string, unknown>)[];
  const failed = steps.some(isFailedStep);
  const active = failed || steps.some((value) => ["claimed", "abandoned", "erased"].some((key) => typeof value[key] === "number" && (value[key] as number) > 0));
  return { failed, active };
}
