import type { Pool, PoolClient } from "pg";
import { StoreConflictError, StoreNotFoundError, StoreValidationError } from "./errors.ts";
import { requireMembership } from "./repository.ts";
import { withTransaction } from "./transaction.ts";
import type { HostActor } from "./types.ts";
import { assertCanonicalInstant, assertStoreIdentifier } from "./validation.ts";

export interface GuestMeetingGuide {
  readonly collectionOverview: string;
  readonly address: string;
  readonly accessInstructions: string;
  readonly entranceInstructions: string;
  readonly mapUrl: string | null;
  readonly photoAssetId: string;
  readonly itemsToBring: readonly string[];
  readonly weatherPlan: string;
}

export interface VersionedGuestMeetingGuide {
  readonly version: number | null;
  readonly guide: GuestMeetingGuide | null;
  readonly updatedAtUtc: string | null;
}

export interface GuestBookingMeetingGuide extends Omit<GuestMeetingGuide, "dayOfContactPhone"> {
  /** True only on the booked local calendar day. */
  readonly isDayOf: boolean;
  readonly photoUrl: string | null;
}

const CONTROL = /[\u0000-\u001F\u007F]/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GUIDE_KEYS = ["collectionOverview", "address", "accessInstructions", "entranceInstructions", "mapUrl", "photoAssetId", "itemsToBring", "weatherPlan"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedText(value: unknown, field: string, max: number, allowEmpty = false): string {
  if (typeof value !== "string" || value.length > max || CONTROL.test(value) || (!allowEmpty && !value.trim())) {
    throw new StoreValidationError(`${field} is invalid.`);
  }
  return value.trim();
}

export function validateGuestMeetingGuide(value: unknown): GuestMeetingGuide {
  if (!isRecord(value) || Object.keys(value).some((key) => !GUIDE_KEYS.includes(key as typeof GUIDE_KEYS[number]))
    || GUIDE_KEYS.some((key) => !Object.hasOwn(value, key))) {
    throw new StoreValidationError("guide has an unsupported shape.");
  }
  const collectionOverview = boundedText(value.collectionOverview, "guide.collectionOverview", 200);
  const address = boundedText(value.address, "guide.address", 500);
  const accessInstructions = boundedText(value.accessInstructions, "guide.accessInstructions", 2_000, true);
  const entranceInstructions = boundedText(value.entranceInstructions, "guide.entranceInstructions", 2_000, true);
  const weatherPlan = boundedText(value.weatherPlan, "guide.weatherPlan", 2_000, true);
  if (value.mapUrl !== null && (typeof value.mapUrl !== "string" || value.mapUrl.length > 2_048)) throw new StoreValidationError("guide.mapUrl is invalid.");
  let mapUrl: string | null = null;
  if (typeof value.mapUrl === "string" && value.mapUrl.trim()) {
    let parsed: URL;
    try { parsed = new URL(value.mapUrl); } catch { throw new StoreValidationError("guide.mapUrl is invalid."); }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new StoreValidationError("guide.mapUrl is invalid.");
    mapUrl = parsed.toString();
  }
  const photoAssetId = value.photoAssetId;
  if (typeof photoAssetId !== "string" || !UUID.test(photoAssetId)) throw new StoreValidationError("guide.photoAssetId is invalid.");
  if (!Array.isArray(value.itemsToBring) || value.itemsToBring.length > 20) throw new StoreValidationError("guide.itemsToBring is invalid.");
  const itemsToBring = value.itemsToBring.map((item, index) => boundedText(item, `guide.itemsToBring.${index}`, 200));
  return { collectionOverview, address, accessInstructions, entranceInstructions, mapUrl, photoAssetId, itemsToBring, weatherPlan };
}

function guideFromJson(value: unknown): GuestMeetingGuide {
  if (!isRecord(value)) throw new StoreValidationError("The saved meeting guide is invalid.");
  return validateGuestMeetingGuide(value);
}

/** Owner-only source for private booking logistics. Changes never alter sale terms or the public publication. */
export class GuestMeetingGuideRepository {
  readonly #pool: Pool;

  constructor(pool: Pool) { this.#pool = pool; }

  async readForProduct(actor: HostActor, productId: string): Promise<VersionedGuestMeetingGuide> {
    assertStoreIdentifier(productId, "productId");
    return withTransaction(this.#pool, async (client) => {
      await requireMembership(client, actor, ["OWNER"]);
      const found = await client.query<{ version: string; guide: unknown; updated_at: Date }>(
        `SELECT g.version::text, g.guide, g.updated_at
           FROM experience_product_booking_guides g
           JOIN experience_products p ON p.provider_id=g.provider_id AND p.id=g.product_id
          WHERE g.provider_id=$1 AND g.product_id=$2`,
        [actor.providerId, productId],
      );
      const row = found.rows[0];
      if (!row) {
        const product = await client.query("SELECT 1 FROM experience_products WHERE provider_id=$1 AND id=$2", [actor.providerId, productId]);
        if (!product.rows[0]) throw new StoreNotFoundError("product");
        return { version: null, guide: null, updatedAtUtc: null };
      }
      return { version: Number(row.version), guide: guideFromJson(row.guide), updatedAtUtc: new Date(row.updated_at).toISOString() };
    });
  }

  async saveForProduct(actor: HostActor, productId: string, expectedVersion: number | null, input: unknown): Promise<VersionedGuestMeetingGuide> {
    assertStoreIdentifier(productId, "productId");
    if (expectedVersion !== null && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)) throw new StoreValidationError("expectedVersion is invalid.");
    const guide = validateGuestMeetingGuide(input);
    return withTransaction(this.#pool, async (client) => {
      await requireMembership(client, actor, ["OWNER"]);
      const product = await client.query("SELECT 1 FROM experience_products WHERE provider_id=$1 AND id=$2 FOR UPDATE", [actor.providerId, productId]);
      if (!product.rows[0]) throw new StoreNotFoundError("product");
      if (guide.photoAssetId) {
        const photo = await client.query(
          `SELECT 1 FROM experience_product_media_assets
            WHERE provider_id=$1 AND product_id=$2 AND id=$3::uuid AND state='READY' AND rights_confirmed_at IS NOT NULL`,
          [actor.providerId, productId, guide.photoAssetId],
        );
        if (!photo.rows[0]) throw new StoreValidationError("guide.photoAssetId must name a rights-confirmed product photo.");
      }
      const current = await client.query<{ version: string }>(
        "SELECT version::text FROM experience_product_booking_guides WHERE provider_id=$1 AND product_id=$2 FOR UPDATE",
        [actor.providerId, productId],
      );
      const currentVersion = current.rows[0] ? Number(current.rows[0].version) : null;
      if (currentVersion !== expectedVersion) throw new StoreConflictError("The booking guide changed; reread before saving.");
      const saved = await client.query<{ version: string; updated_at: Date }>(
        `INSERT INTO experience_product_booking_guides (provider_id,product_id,version,guide)
         VALUES ($1,$2,1,$3::jsonb)
         ON CONFLICT (provider_id,product_id) DO UPDATE
           SET version=experience_product_booking_guides.version+1,guide=EXCLUDED.guide,updated_at=clock_timestamp()
         RETURNING version::text,updated_at`,
        [actor.providerId, productId, JSON.stringify(guide)],
      );
      const row = saved.rows[0]!;
      // Existing upcoming reservations without a guide snapshot get this first version once; later edits never
      // change an already captured reservation. The outbox key makes the email schedule idempotent.
      await client.query(
        `INSERT INTO booking_meeting_guide_snapshots (provider_id,booking_id,guide_version,guide)
         SELECT b.provider_id,b.id,g.version,g.guide
           FROM bookings b JOIN experience_product_booking_guides g ON g.provider_id=b.provider_id AND g.product_id=b.product_id
          WHERE b.provider_id=$1 AND b.product_id=$2 AND b.status='CONFIRMED'
            AND (b.occurrence_snapshot->>'startUtc')::timestamptz>clock_timestamp()
         ON CONFLICT (provider_id,booking_id) DO NOTHING`,
        [actor.providerId, productId],
      );
      await enqueueMeetingGuideEmails(client, actor.providerId, productId);
      return { version: Number(row.version), guide, updatedAtUtc: new Date(row.updated_at).toISOString() };
    });
  }

  /** Remove private meeting addresses once the booking page's 30-day post-experience window has ended. */
  async purgeEndedSnapshots(options: { readonly endedBefore: string; readonly limit?: number }): Promise<number> {
    assertCanonicalInstant(options.endedBefore, "endedBefore");
    const limit = options.limit ?? 200;
    if (!Number.isInteger(limit) || limit < 1 || limit > 2_000) throw new StoreValidationError("limit must be from 1 to 2000.");
    const result = await this.#pool.query(
      `WITH due AS (
         SELECT s.provider_id, s.booking_id
           FROM booking_meeting_guide_snapshots s
           JOIN bookings b ON b.provider_id=s.provider_id AND b.id=s.booking_id
          WHERE (b.occurrence_snapshot->>'endUtc')::timestamptz < $1::timestamptz
          ORDER BY s.provider_id, s.booking_id
          LIMIT $2
       )
       DELETE FROM booking_meeting_guide_snapshots s USING due
        WHERE s.provider_id=due.provider_id AND s.booking_id=due.booking_id`,
      [options.endedBefore, limit],
    );
    return result.rowCount ?? 0;
  }
}

/** Called in the payment-confirmation transaction; one immutable snapshot per confirmed booking. */
export async function snapshotGuestMeetingGuide(client: PoolClient, booking: { providerId: string; bookingId: string; productId: string }): Promise<void> {
  const guide = await client.query<{ version: string; guide: unknown }>(
    `SELECT version::text, guide FROM experience_product_booking_guides
      WHERE provider_id=$1 AND product_id=$2 FOR SHARE`,
    [booking.providerId, booking.productId],
  );
  const row = guide.rows[0];
  if (!row) return;
  await client.query(
    `INSERT INTO booking_meeting_guide_snapshots (provider_id,booking_id,guide_version,guide)
     VALUES ($1,$2::bigint,$3::bigint,$4::jsonb) ON CONFLICT (provider_id,booking_id) DO NOTHING`,
    [booking.providerId, booking.bookingId, row.version, JSON.stringify(guideFromJson(row.guide))],
  );
  await enqueueMeetingGuideEmails(client, booking.providerId, booking.productId, booking.bookingId);
}

async function enqueueMeetingGuideEmails(client: PoolClient, providerId: string, productId: string, bookingId?: string): Promise<void> {
  await client.query(
    `INSERT INTO outbox_messages
       (provider_id,aggregate_type,aggregate_id,topic,deduplication_key,payload,available_at)
     SELECT b.provider_id,'booking',b.public_booking_id::text,'booking.meeting_guide_day_before',
            'meeting-guide-day-before:'||b.public_booking_id::text,
            jsonb_build_object('publicBookingId',b.public_booking_id::text),
            GREATEST(clock_timestamp(),(b.occurrence_snapshot->>'startUtc')::timestamptz-interval '24 hours')
       FROM bookings b
       JOIN booking_meeting_guide_snapshots snapshot ON snapshot.provider_id=b.provider_id AND snapshot.booking_id=b.id
      WHERE b.provider_id=$1 AND b.product_id=$2 AND b.status='CONFIRMED'
        AND (b.occurrence_snapshot->>'startUtc')::timestamptz>clock_timestamp()
        AND ($3::bigint IS NULL OR b.id=$3::bigint)
     ON CONFLICT (provider_id,deduplication_key) DO NOTHING`,
    [providerId, productId, bookingId ?? null],
  );
}
