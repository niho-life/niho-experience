import "server-only";
import type { HostPushRecipient, HostPushSubscriptions } from "@niho-experience/experience-store";
import { sendWebPush, type PushOutcome, type VapidKeys } from "@niho-experience/web-push";
import { hostPushDelivery, hostPushPayload, hostPushTopic, type HostPushEvent } from "./payload";

/** A device that has not been seen for this long gets nothing (#177: the app was not opened). */
export const HOST_PUSH_SEEN_WITHIN_MS = 30 * 24 * 60 * 60 * 1000;
const CONCURRENCY = 4;

export interface HostPushDeps {
  subscriptions: Pick<HostPushSubscriptions, "recipients" | "recordSent" | "recordFailure" | "removeById">;
  vapid: VapidKeys;
  fetch: typeof fetch;
  now: number;
}

export interface HostPushReport {
  recipients: number;
  sent: number;
  gone: number;
  failed: number;
}

export interface HostPushSend {
  payload: string;
  urgency: "high" | "normal";
  ttlSeconds: number;
  topic: string;
}

/** One message to one device, and its result kept in the store: success, gone (the row goes) or another failure. */
export async function deliverHostPush(recipient: HostPushRecipient, message: HostPushSend, deps: HostPushDeps): Promise<PushOutcome> {
  let outcome: PushOutcome;
  try {
    outcome = (await sendWebPush({ subscription: recipient, ...message, vapid: deps.vapid, fetch: deps.fetch, now: deps.now })).outcome;
  } catch {
    outcome = "rejected";
  }
  try {
    if (outcome === "sent") await deps.subscriptions.recordSent(recipient.id);
    else if (outcome === "gone") await deps.subscriptions.removeById(recipient.id);
    else await deps.subscriptions.recordFailure(recipient.id);
  } catch {
    // Bookkeeping is best effort; the next message tries again.
  }
  return outcome;
}

/**
 * Sends one event to the devices of the provider's active members seen in the last 30 days, four at
 * a time. Push is a second channel next to email, never a replacement. The notification job that
 * consumes `outbox_messages` calls it (outbox.ts, docs/host-pwa.md).
 */
export async function notifyHostDevices(event: HostPushEvent, deps: HostPushDeps): Promise<HostPushReport> {
  const message: HostPushSend = { payload: hostPushPayload(event), ...hostPushDelivery(event.kind), topic: hostPushTopic(event.tag) };
  const recipients = await deps.subscriptions.recipients(event.providerId, new Date(deps.now - HOST_PUSH_SEEN_WITHIN_MS));

  const report: HostPushReport = { recipients: recipients.length, sent: 0, gone: 0, failed: 0 };
  let next = 0;
  const worker = async () => {
    while (next < recipients.length) {
      const recipient = recipients[next++]!;
      const outcome = await deliverHostPush(recipient, message, deps);
      if (outcome === "sent") report.sent += 1;
      else if (outcome === "gone") report.gone += 1;
      else report.failed += 1;
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, recipients.length) }, worker));
  return report;
}
