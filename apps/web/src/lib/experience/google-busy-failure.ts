import "server-only";
import type { PoolClient } from "pg";
import { GoogleCalendarError } from "@niho-experience/google-calendar";
import { enqueueGoogleCalendarAttentionNotification } from "@niho-experience/experience-store";

/**
 * A Google busy input that cannot be read closes the new bookings that need it at once (its freshness is cleared) and
 * keeps them closed until a read succeeds; bookings already taken stay (#238). The OWNER hears of it: at once and once
 * per connection when Google refused it, otherwise once per input after 15 minutes of failed reads (one slow answer is
 * not news).
 */
export type GoogleBusyFailureReason = "REVOKED" | "UNAVAILABLE";

export const GOOGLE_BUSY_NOTICE_AFTER_MINUTES = 15;

export function googleBusyFailureReason(error: unknown): GoogleBusyFailureReason {
  return error instanceof GoogleCalendarError && error.reason === "REVOKED" ? "REVOKED" : "UNAVAILABLE";
}

/** Minutes to the next read: a refused connection does not come back until the OWNER reconnects (or the client is fixed). */
export function googleBusyRetryMinutes(reason: GoogleBusyFailureReason): number {
  return reason === "REVOKED" ? 30 : 5;
}

/**
 * Called in the transaction that recorded the failure, with the row's `failing_since` and whether it is at least
 * GOOGLE_BUSY_NOTICE_AFTER_MINUTES old (the database's clock).
 */
export async function noticeGoogleBusyFailure(client: PoolClient, input: {
  readonly providerId: string;
  readonly input: "PROVIDER" | "RESOURCE";
  readonly inputId: string;
  readonly reason: GoogleBusyFailureReason;
  readonly connectionGeneration: number;
  readonly failingSince: Date;
  readonly longFailing: boolean;
}): Promise<void> {
  if (input.reason !== "REVOKED" && !input.longFailing) return;
  await enqueueGoogleCalendarAttentionNotification(client, {
    providerId: input.providerId,
    input: input.input,
    inputId: input.inputId,
    reason: input.reason,
    connectionGeneration: input.connectionGeneration,
    failingSinceUtc: input.failingSince.toISOString(),
  });
}
