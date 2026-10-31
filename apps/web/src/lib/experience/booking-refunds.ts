import "server-only";
import { submitBookingRefund } from "@niho-experience/experience-payments";
import type { BookingCancellations, RefundSubmission, RefundStatus, StripeRefundAnswer } from "@niho-experience/experience-store";

/*
 * Sends the refunds a cancellation asked for to Stripe (#285 slice 7, docs/guest-booking.md「取消と返金（第7段）」) and
 * records Stripe's answer. The cancellation itself is already committed: a refund that cannot be sent now stays
 * requested, and the same command again, support's 「もう一度返金する」 or the webhook finish it. A refund is found at
 * Stripe by its ID before it is created, so sending it again never refunds twice. Logs say which step failed and the
 * error's class only: Stripe's and the database's messages can repeat IDs.
 */

export interface RefundSendDeps {
  readonly cancellations: Pick<BookingCancellations, "recordRefundSubmission">;
  /** Stripe on the seller's account; null when the platform key is not configured. */
  readonly submit: ((refund: RefundSubmission) => Promise<StripeRefundAnswer>) | null;
  readonly log?: (stage: "stripe" | "store", errorName: string) => void;
}

export interface SentRefund {
  readonly refundId: string;
  /** What the refund is now; REQUESTED when Stripe could not be reached (or answered nothing definite). */
  readonly status: RefundStatus;
}

function defaultLog(stage: "stripe" | "store", errorName: string): void {
  console.error("Experience refund could not be sent", { stage, error: errorName });
}

const errorName = (error: unknown) => (error instanceof Error ? error.name : typeof error);

/** One at a time, in order; one that fails does not stop the others. */
export async function sendRefunds(refunds: readonly RefundSubmission[], deps: RefundSendDeps): Promise<SentRefund[]> {
  const log = deps.log ?? defaultLog;
  const sent: SentRefund[] = [];
  for (const refund of refunds) {
    if (!deps.submit) {
      sent.push({ refundId: refund.refundId, status: "REQUESTED" });
      continue;
    }
    let answer: StripeRefundAnswer;
    try {
      answer = await deps.submit(refund);
    } catch (error) {
      log("stripe", errorName(error));
      sent.push({ refundId: refund.refundId, status: "REQUESTED" });
      continue;
    }
    try {
      sent.push({ refundId: refund.refundId, status: await deps.cancellations.recordRefundSubmission(refund.refundId, answer) });
    } catch (error) {
      // Stripe has it; its webhook records it (the refund carries our ID).
      log("store", errorName(error));
      sent.push({ refundId: refund.refundId, status: "REQUESTED" });
    }
  }
  return sent;
}

/** Stripe with the platform key (EXPERIENCE_STRIPE_PLATFORM_SECRET_KEY), or null without it. */
export function stripeRefundSubmitter(): RefundSendDeps["submit"] {
  const platformStripeKey = process.env.EXPERIENCE_STRIPE_PLATFORM_SECRET_KEY;
  if (!platformStripeKey) return null;
  return (refund) => submitBookingRefund({ refund, platformStripeKey });
}
