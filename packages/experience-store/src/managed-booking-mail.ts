import type { PoolClient } from "pg";

/** Durable mail topics for MANAGED_20 bookings. Recipients and Checkout URLs are resolved only when sent. */
export const MANAGED_GUEST_MAIL_TOPICS = {
  requestReceived: "managed.guest.request_received",
  paymentReady: "managed.guest.payment_ready",
  requestDeclined: "managed.guest.request_declined",
  requestExpired: "managed.guest.request_expired",
  paymentFailed: "managed.guest.payment_failed",
} as const;

export const MANAGED_OPERATIONS_MAIL_TOPICS = {
  officeNewRequest: "managed.office.new_request",
  officeConfirmed: "managed.office.confirmed",
  officeCancelled: "managed.office.cancelled",
  providerConfirmed: "managed.provider.confirmed",
  providerCancelled: "managed.provider.cancelled",
} as const;

export type ManagedGuestMailTopic = (typeof MANAGED_GUEST_MAIL_TOPICS)[keyof typeof MANAGED_GUEST_MAIL_TOPICS];
export type ManagedOperationsMailTopic = (typeof MANAGED_OPERATIONS_MAIL_TOPICS)[keyof typeof MANAGED_OPERATIONS_MAIL_TOPICS];

interface ManagedBookingMailRef {
  readonly providerId: string;
  readonly publicBookingId: string;
}

async function enqueue(
  client: PoolClient,
  booking: ManagedBookingMailRef,
  topic: ManagedGuestMailTopic | ManagedOperationsMailTopic,
  availableAt?: string,
): Promise<void> {
  await client.query(
    `INSERT INTO outbox_messages
       (provider_id,aggregate_type,aggregate_id,topic,deduplication_key,payload,available_at)
     VALUES ($1,'booking',$2,$3,$4,jsonb_build_object('v',1),COALESCE($5::timestamptz,clock_timestamp()))
     ON CONFLICT (provider_id,deduplication_key) DO NOTHING`,
    [booking.providerId, booking.publicBookingId, topic, `${topic}:${booking.publicBookingId}`, availableAt ?? null],
  );
}

/** Same transaction as a MANAGED_20 booking request. */
export async function enqueueManagedBookingStarted(
  client: PoolClient,
  booking: ManagedBookingMailRef & { readonly approval: boolean; readonly holdExpiresAtUtc: string },
): Promise<void> {
  if (!booking.approval) return;
  await enqueue(client, booking, MANAGED_OPERATIONS_MAIL_TOPICS.officeNewRequest);
  await enqueue(client, booking, MANAGED_GUEST_MAIL_TOPICS.requestReceived);
  await enqueue(client, booking, MANAGED_GUEST_MAIL_TOPICS.requestExpired, booking.holdExpiresAtUtc);
}

/** Same transaction as durable attachment; safe to call again for the identical Session. */
export async function enqueueManagedPaymentReady(client: PoolClient, booking: ManagedBookingMailRef): Promise<void> {
  await enqueue(client, booking, MANAGED_GUEST_MAIL_TOPICS.paymentReady);
}

/** Same transaction as an Admin decline. */
export async function enqueueManagedRequestDeclined(client: PoolClient, booking: ManagedBookingMailRef): Promise<void> {
  await enqueue(client, booking, MANAGED_GUEST_MAIL_TOPICS.requestDeclined);
}

/** Same transaction as a MANAGED_20 confirmation. */
export async function enqueueManagedBookingConfirmed(client: PoolClient, booking: ManagedBookingMailRef): Promise<void> {
  await enqueue(client, booking, MANAGED_OPERATIONS_MAIL_TOPICS.officeConfirmed);
  await enqueue(client, booking, MANAGED_OPERATIONS_MAIL_TOPICS.providerConfirmed);
}

/** Same transaction as cancellation of a previously confirmed MANAGED_20 booking. */
export async function enqueueManagedBookingCancelled(client: PoolClient, booking: ManagedBookingMailRef): Promise<void> {
  await enqueue(client, booking, MANAGED_OPERATIONS_MAIL_TOPICS.officeCancelled);
  await enqueue(client, booking, MANAGED_OPERATIONS_MAIL_TOPICS.providerCancelled);
}

/** Same transaction as a verified failure of the attached asynchronous payment. */
export async function enqueueManagedPaymentFailed(client: PoolClient, booking: ManagedBookingMailRef): Promise<void> {
  await enqueue(client, booking, MANAGED_GUEST_MAIL_TOPICS.paymentFailed);
}

/** A verified matching ended Session makes the already-durable expiry row immediately due. */
export async function expediteManagedRequestExpiry(client: PoolClient, booking: ManagedBookingMailRef): Promise<void> {
  await client.query(
    `UPDATE outbox_messages
        SET available_at=LEAST(available_at,clock_timestamp())
      WHERE provider_id=$1 AND aggregate_type='booking' AND aggregate_id=$2
        AND topic=$3 AND processed_at IS NULL`,
    [booking.providerId, booking.publicBookingId, MANAGED_GUEST_MAIL_TOPICS.requestExpired],
  );
}
