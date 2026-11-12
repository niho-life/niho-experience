import type { Pool } from "pg";
import { StoreConflictError, StoreNotFoundError, StoreValidationError } from "./errors.ts";
import { lockProviderInventory } from "./inventory.ts";
import { enqueueCalendarRecalculation } from "./inventory-outbox.ts";
import { bookingFromRow, isoValue, type DbRow } from "./rows.ts";
import { withTransaction } from "./transaction.ts";
import type { BookingRecord, PublicationAdminDraftActor } from "./types.ts";
import { assertStoreIdentifier } from "./validation.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ManagedBookingApprovalRequest {
  readonly publicBookingId: string;
  readonly status: "PENDING" | "APPROVED";
  readonly bookingStatus: BookingRecord["status"];
  readonly holdExpiresAtUtc: string;
  readonly holdActive: boolean;
  readonly experienceTitle: string;
  readonly localDate: string;
  readonly localStartTime: string;
  readonly adultCount: number;
  readonly childCount: number;
  readonly totalAmount: number;
  readonly currency: string;
  readonly guestName: string | null;
  readonly guestEmail: string | null;
  readonly guestPhone: string | null;
  readonly createdAtUtc: string;
}

export interface ApprovedManagedBookingRequest {
  readonly booking: BookingRecord;
  readonly guestEmail: string | null;
  readonly checkoutSessionRef: string | null;
}

function requestId(value: string): void {
  if (typeof value !== "string" || !UUID.test(value)) throw new StoreValidationError("publicBookingId must be a UUID.");
}

function approvalSnapshot(row: DbRow): Record<string, unknown> {
  const raw = row.seller_snapshot;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new StoreConflictError("The booking is not a managed approval request.");
  }
  const seller = raw as Record<string, unknown>;
  if (seller.acceptanceMode !== "APPROVAL" || seller.salesPlan !== "MANAGED_20" || seller.chargeMode !== "PLATFORM") {
    throw new StoreConflictError("The booking is not a managed approval request.");
  }
  return seller as Record<string, unknown>;
}

/** Admin-only request-to-book decisions. Stripe creation stays in the authenticated HTTP boundary. */
export class ManagedBookingApprovalRepository {
  readonly #pool: Pool;
  constructor(pool: Pool) { this.#pool = pool; }

  async listPending(actor: PublicationAdminDraftActor, limit = 100): Promise<ManagedBookingApprovalRequest[]> {
    assertStoreIdentifier(actor?.nihoUserId, "actor.nihoUserId");
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new StoreValidationError("limit must be from 1 to 100.");
    const rows = await this.#pool.query<DbRow>(
      `SELECT b.public_booking_id::text AS public_booking_id,b.status AS booking_status,b.hold_expires_at,g.approval_status,
              b.hold_expires_at > clock_timestamp() AS hold_active,b.occurrence_snapshot,b.pricing_snapshot,
              b.created_at,p.public_title,g.guest_name,g.guest_email,g.guest_phone,g.adult_count,g.child_count
         FROM booking_guests g
         JOIN bookings b ON b.provider_id=g.provider_id AND b.id=g.booking_id
         JOIN experience_products p ON p.provider_id=b.provider_id AND p.id=b.product_id
        WHERE g.approval_status IN ('PENDING','APPROVED') AND b.status='HOLD'
          AND b.hold_expires_at > clock_timestamp()
          AND b.seller_snapshot->>'acceptanceMode'='APPROVAL'
          AND b.seller_snapshot->>'salesPlan'='MANAGED_20'
        ORDER BY b.created_at,b.public_booking_id LIMIT $1`,
      [limit],
    );
    return rows.rows.map((row) => {
      const occurrence = row.occurrence_snapshot as Record<string, unknown>;
      const pricing = row.pricing_snapshot as Record<string, unknown>;
      return {
        publicBookingId: String(row.public_booking_id), status: String(row.approval_status) as "PENDING" | "APPROVED",
        bookingStatus: String(row.booking_status) as BookingRecord["status"],
        holdExpiresAtUtc: isoValue(row, "hold_expires_at"), holdActive: row.hold_active === true,
        experienceTitle: String(row.public_title), localDate: String(occurrence.localDate),
        localStartTime: String(occurrence.localStartTime), adultCount: Number(row.adult_count), childCount: Number(row.child_count),
        totalAmount: Number(pricing.totalAmount), currency: String(pricing.currency),
        guestName: row.guest_name === null ? null : String(row.guest_name),
        guestEmail: row.guest_email === null ? null : String(row.guest_email),
        guestPhone: row.guest_phone === null ? null : String(row.guest_phone),
        createdAtUtc: isoValue(row, "created_at"),
      };
    });
  }

  async approve(actor: PublicationAdminDraftActor, publicBookingId: string): Promise<ApprovedManagedBookingRequest> {
    assertStoreIdentifier(actor?.nihoUserId, "actor.nihoUserId"); requestId(publicBookingId);
    const located = await this.#pool.query<DbRow>("SELECT provider_id FROM bookings WHERE public_booking_id=$1::uuid", [publicBookingId]);
    if (!located.rows[0]) throw new StoreNotFoundError("approval request");
    const providerId = String(located.rows[0].provider_id);
    return withTransaction(this.#pool, async (client) => {
      await lockProviderInventory(client, providerId);
      const found = await client.query<DbRow>(
        `SELECT b.id,b.public_booking_id::text AS public_booking_id,b.provider_id,b.product_id,b.occurrence_id,
                b.status,b.seats,b.idempotency_key,b.hold_expires_at,b.occurrence_snapshot,b.pricing_snapshot,
                b.seller_snapshot,b.stripe_payment_ref,b.created_at,b.confirmed_at,
                g.approval_status,g.approval_decided_by_admin_niho_user_id,
                g.guest_email,g.checkout_session_ref,b.hold_expires_at > clock_timestamp() AS hold_active,
                b.hold_expires_at > clock_timestamp() + interval '32 minutes' AS checkout_window_open
           FROM bookings b JOIN booking_guests g ON g.provider_id=b.provider_id AND g.booking_id=b.id
          WHERE b.provider_id=$1 AND b.public_booking_id=$2::uuid FOR UPDATE OF b,g`,
        [providerId, publicBookingId],
      );
      const row = found.rows[0]; if (!row) throw new StoreNotFoundError("approval request");
      const seller = approvalSnapshot(row);
      if (row.approval_status === "DECLINED") throw new StoreConflictError("The request was already declined.");
      if (row.approval_status !== "PENDING" && row.approval_status !== "APPROVED") throw new StoreConflictError("The request has no approval state.");
      if (row.status !== "HOLD" || row.hold_active !== true) throw new StoreConflictError("The request hold has expired.");
      // Stripe needs a 30-minute minimum expiry; reserve the adapter's margin and time to create the Session.
      if (row.checkout_session_ref === null && row.checkout_window_open !== true) {
        throw new StoreConflictError("The request is too close to expiry to create a payment link.");
      }
      const plan = await client.query<DbRow>(
        `SELECT current_revision,phase FROM experience_product_sales_plan_states
          WHERE provider_id=$1 AND product_id=$2 FOR SHARE`, [providerId, row.product_id],
      );
      if (plan.rows[0]?.phase !== "ACTIVE" || Number(plan.rows[0]?.current_revision) !== seller.salesPlanRevision) {
        throw new StoreConflictError("The request sales plan is no longer active.");
      }
      if (row.approval_status === "PENDING") {
        await client.query(
          `UPDATE booking_guests SET approval_status='APPROVED',
              approval_decided_by_admin_niho_user_id=$3,approval_decided_at=clock_timestamp()
            WHERE provider_id=$1 AND booking_id=$2 AND approval_status='PENDING'`,
          [providerId, row.id, actor.nihoUserId],
        );
      }
      return {
        booking: bookingFromRow(row),
        guestEmail: row.guest_email === null ? null : String(row.guest_email),
        checkoutSessionRef: row.checkout_session_ref === null ? null : String(row.checkout_session_ref),
      };
    });
  }

  async decline(actor: PublicationAdminDraftActor, publicBookingId: string): Promise<void> {
    assertStoreIdentifier(actor?.nihoUserId, "actor.nihoUserId"); requestId(publicBookingId);
    const located = await this.#pool.query<DbRow>("SELECT provider_id FROM bookings WHERE public_booking_id=$1::uuid", [publicBookingId]);
    if (!located.rows[0]) throw new StoreNotFoundError("approval request");
    const providerId = String(located.rows[0].provider_id);
    await withTransaction(this.#pool, async (client) => {
      await lockProviderInventory(client, providerId);
      const found = await client.query<DbRow>(
        `SELECT b.id,b.status,b.occurrence_id,b.seller_snapshot,g.approval_status,g.checkout_session_ref
           FROM bookings b JOIN booking_guests g ON g.provider_id=b.provider_id AND g.booking_id=b.id
          WHERE b.provider_id=$1 AND b.public_booking_id=$2::uuid FOR UPDATE OF b,g`,
        [providerId, publicBookingId],
      );
      const row = found.rows[0]; if (!row) throw new StoreNotFoundError("approval request");
      approvalSnapshot(row);
      if (row.approval_status !== "PENDING" || row.checkout_session_ref !== null) {
        throw new StoreConflictError("Only a pending request can be declined.");
      }
      if (row.status !== "HOLD" && row.status !== "EXPIRED") throw new StoreConflictError("The request can no longer be declined.");
      await client.query(
        `UPDATE booking_guests SET approval_status='DECLINED',
            approval_decided_by_admin_niho_user_id=$3,approval_decided_at=clock_timestamp()
          WHERE provider_id=$1 AND booking_id=$2 AND approval_status='PENDING'`,
        [providerId, row.id, actor.nihoUserId],
      );
      if (row.status === "HOLD") {
        await client.query("UPDATE bookings SET status='EXPIRED',updated_at=clock_timestamp() WHERE provider_id=$1 AND id=$2", [providerId, row.id]);
        await enqueueCalendarRecalculation(client, {
          providerId, aggregateType: "schedule_occurrence", aggregateId: String(row.occurrence_id), cause: "booking_hold_released",
        });
      }
    });
  }
}
