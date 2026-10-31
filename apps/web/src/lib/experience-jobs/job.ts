import "server-only";
import type { Pool } from "pg";
import { BookingCancellations, GuestBookingAccess, GuestBookingRepository, GuestMailOutbox, GuestQuestionRepository, GuestQuestionTranslations } from "@niho-experience/experience-store";
import { config } from "@/lib/config";
import { stripeRefundSubmitter, type RefundSendDeps } from "@/lib/experience/booking-refunds";
import { experiencePool } from "@/lib/experience/store-server";
import { verifyGoogleServiceIdentity, type GoogleServiceTokenVerifier } from "@/lib/google-service-identity";
import { smtpMailer, type Mailer } from "@/lib/mail/transport";
import { anthropicTranslator, type Translator } from "@/lib/translation/anthropic";
import { EXPERIENCE_JOB_LIMITS, experienceJobActivity, runExperienceJobs, type ExperienceJobCounts, type ExperienceJobDeps } from "./drain";

export interface ExperienceJobSettings {
  readonly enabled: boolean;
  readonly audience: string;
  readonly serviceAccountEmail: string;
}

export interface ExperienceJobDependencies {
  readonly settings?: ExperienceJobSettings;
  readonly verifier?: GoogleServiceTokenVerifier;
  readonly pool?: () => Pool | null;
  readonly mailer?: () => Mailer | null;
  /** The Claude API for the guests' Japanese; null while translation is off. */
  readonly translator?: () => Translator | null;
  /**
   * Whether booking on this site is on (#285 slice 6): the booking page's links go into the emails, and refunds
   * Stripe never accepted are sent again (#285 slice 7b), only then.
   */
  readonly bookingPages?: boolean;
  /** Stripe with the platform key for sending refunds again; null without the key. */
  readonly refundSubmitter?: () => RefundSendDeps["submit"];
  readonly run?: (deps: ExperienceJobDeps) => Promise<ExperienceJobCounts>;
}

/** JSON for an internal route: never cached, sniffed or indexed. */
function internalServiceJson(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}

/**
 * POST /internal/experience-jobs/v1/drain (#285 slice 5): Cloud Scheduler runs the mail job with its own
 * service account's Google ID token. 404 while guest mail is off, 401 for any other caller, 503 when
 * Google's keys, the experience DB or the SMTP credentials are not there. The answer and the one log
 * line are counts only; a run in which a step failed answers 503 with the same counts.
 */
export async function experienceJobsDrainResponse(request: Pick<Request, "headers">, dependencies: ExperienceJobDependencies = {}): Promise<Response> {
  const settings = dependencies.settings ?? {
    enabled: config.guestMailEnabled,
    audience: config.experienceJobsAudience,
    serviceAccountEmail: config.experienceJobsServiceAccountEmail,
  };
  if (!settings.enabled) return internalServiceJson({ error: "not_found" }, 404);
  const identity = await verifyGoogleServiceIdentity(request, settings, dependencies.verifier);
  if (!identity.ok) {
    return identity.kind === "outage"
      ? internalServiceJson({ error: "identity_verification_unavailable" }, 503)
      : internalServiceJson({ error: "invalid_identity" }, 401);
  }
  const pool = (dependencies.pool ?? experiencePool)();
  if (!pool) return internalServiceJson({ error: "unavailable" }, 503);
  const mailer = (dependencies.mailer ?? smtpMailer)();
  if (!mailer) return internalServiceJson({ error: "unavailable" }, 503);
  const errors: Record<string, string> = {};
  const outbox = new GuestMailOutbox(pool);
  const guestBooking = dependencies.bookingPages ?? config.guestBookingEnabled;
  const submit = guestBooking ? (dependencies.refundSubmitter ?? stripeRefundSubmitter)() : null;
  try {
    const counts = await (dependencies.run ?? runExperienceJobs)({
      questions: new GuestQuestionRepository(pool),
      confirmations: outbox,
      notices: outbox,
      bookingLinks: outbox,
      // The page needs both flags; this job runs only with guest mail on, so booking on this site decides.
      access: guestBooking ? new GuestBookingAccess(pool) : null,
      refunds: submit ? { cancellations: new BookingCancellations(pool), submit } : null,
      guests: new GuestBookingRepository(pool),
      translations: new GuestQuestionTranslations(pool),
      translator: (dependencies.translator ?? (() => anthropicTranslator({ timeoutMs: EXPERIENCE_JOB_LIMITS.translationTimeoutMs })))(),
      mailer,
      siteUrl: config.siteUrl,
      now: () => new Date(),
      onStepError: (step, errorName) => {
        errors[step] = errorName;
      },
    });
    const { failed, active } = experienceJobActivity(counts);
    if (failed) console.error(`[experience-jobs] drain ${JSON.stringify({ ...counts, errors })}`);
    else if (active) console.info(`[experience-jobs] drain ${JSON.stringify(counts)}`);
    return internalServiceJson(counts, failed ? 503 : 200);
  } catch (error) {
    // Only an unexpected failure outside the steps; the error's name only.
    console.error(`[experience-jobs] drain failed: ${error instanceof Error ? error.name : "unknown error"}`);
    return internalServiceJson({ error: "unavailable" }, 503);
  } finally {
    mailer.close();
  }
}
