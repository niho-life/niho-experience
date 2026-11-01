import type { Pool, PoolClient } from "pg";
import { StoreValidationError } from "./errors.ts";
import { HOST_NOTIFICATION_TOPICS } from "./host-notification-outbox.ts";
import type { DbRow } from "./rows.ts";
import { assertCanonicalInstant } from "./validation.ts";

/*
 * 予約者の情報つきの OTA の予約 (#194, owner decision 2026-11-01): what a reservation site's reader says about the guest
 * of one external reservation (migration 0036). Each site fills in only what it has: every field is optional, and a
 * reader that cannot see a field leaves it out rather than guessing. The amount is never part of it. These details are
 * kept apart from the inventory facts: they never change the ledger's fingerprint, its order or its seats, and a
 * reservation without them works as before. Erased a year after the experience, as this site's guests are (#285).
 */

/** Age bands a site may break a party into. A site's own names map onto these; one that does not fit is left out. */
export const EXTERNAL_RESERVATION_PARTY_BANDS = ["ADULT", "SENIOR", "YOUTH", "STUDENT", "CHILD", "INFANT"] as const;
export type ExternalReservationPartyBand = (typeof EXTERNAL_RESERVATION_PARTY_BANDS)[number];

export interface ExternalReservationPartyCount {
  readonly band: ExternalReservationPartyBand;
  readonly count: number;
}

export interface ExternalReservationGuestDetails {
  /** The name the guest booked under, as the site shows it. */
  readonly name?: string;
  /** The party by age band; the counts add up to the observation's seats. */
  readonly partyBreakdown?: readonly ExternalReservationPartyCount[];
  readonly email?: string;
  readonly phone?: string;
  /** A BCP 47 tag (en, ja, en-US). */
  readonly language?: string;
  /** The site's booking reference, which the host may see to find the booking on that site. */
  readonly bookingReference?: string;
  /** What the guest wrote to the site (special requests and the like). */
  readonly notes?: string;
}

export const EXTERNAL_RESERVATION_GUEST_KEYS = ["name", "partyBreakdown", "email", "phone", "language", "bookingReference", "notes"] as const;

export const EXTERNAL_RESERVATION_GUEST_LIMITS = {
  nameMax: 200,
  emailMax: 254,
  phoneMax: 32,
  languageMax: 35,
  bookingReferenceMax: 64,
  notesMax: 1_000,
  /** The mail job's erasure: details erased per run. */
  erasedPerRunMax: 5_000,
  /** A push's guest name leaves an outbox row that was never sent after this long. */
  unsentNotificationHours: 48,
} as const;

const CONTROL = /[\u0000-\u001f\u007f]/;
const NOTES_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;
const EMAIL = /^[^\s\u0000-\u001f\u007f@]+@[^\s\u0000-\u001f\u007f@]+\.[^\s\u0000-\u001f\u007f@]+$/;
const PHONE = /^\+?[0-9 ().-]+$/;
const LANGUAGE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/;
const BOOKING_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function text(value: unknown, path: string, max: number, control: RegExp): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max || value !== value.trim() || control.test(value)) {
    throw new StoreValidationError(`${path} must be 1-${max} characters without surrounding spaces or control characters.`);
  }
  return value;
}

function partyBreakdown(value: unknown, path: string, seats: number): readonly ExternalReservationPartyCount[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > EXTERNAL_RESERVATION_PARTY_BANDS.length) {
    throw new StoreValidationError(`${path} must list 1-${EXTERNAL_RESERVATION_PARTY_BANDS.length} age bands.`);
  }
  const counts = new Map<ExternalReservationPartyBand, number>();
  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry) || Object.keys(entry).length !== 2 || !("band" in entry) || !("count" in entry)
      || !(EXTERNAL_RESERVATION_PARTY_BANDS as readonly unknown[]).includes(entry.band)
      || !Number.isInteger(entry.count) || (entry.count as number) < 1 || (entry.count as number) > 1_000) {
      throw new StoreValidationError(`${path}[${index}] must be a known band with a count from 1 to 1000.`);
    }
    const band = entry.band as ExternalReservationPartyBand;
    if (counts.has(band)) throw new StoreValidationError(`${path} names ${band} twice.`);
    counts.set(band, entry.count as number);
  }
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  if (total !== seats) throw new StoreValidationError(`${path} must add up to the reservation's seats.`);
  // One order whatever the site's: the same party is the same details.
  return EXTERNAL_RESERVATION_PARTY_BANDS.filter((band) => counts.has(band)).map((band) => ({ band, count: counts.get(band)! }));
}

/**
 * A reader's guest details, checked and in one key order, or a StoreValidationError naming the field (never its value).
 * `seats` is the observation's, which a breakdown must add up to. An object without any field is refused: a reader
 * with nothing to say leaves `guest` out.
 */
export function canonicalExternalReservationGuest(value: unknown, seats: number, path = "guest"): ExternalReservationGuestDetails {
  if (!isRecord(value)) throw new StoreValidationError(`${path} must be an object.`);
  const keys = Object.keys(value);
  if (keys.length === 0) throw new StoreValidationError(`${path} must contain at least one field.`);
  if (keys.some((key) => !(EXTERNAL_RESERVATION_GUEST_KEYS as readonly string[]).includes(key))) {
    throw new StoreValidationError(`${path} has unknown fields.`);
  }
  const limits = EXTERNAL_RESERVATION_GUEST_LIMITS;
  const result: { -readonly [K in keyof ExternalReservationGuestDetails]: ExternalReservationGuestDetails[K] } = {};
  if (value.name !== undefined) result.name = text(value.name, `${path}.name`, limits.nameMax, CONTROL);
  if (value.partyBreakdown !== undefined) result.partyBreakdown = partyBreakdown(value.partyBreakdown, `${path}.partyBreakdown`, seats);
  if (value.email !== undefined) {
    const email = text(value.email, `${path}.email`, limits.emailMax, CONTROL);
    if (email.length < 3 || !EMAIL.test(email)) throw new StoreValidationError(`${path}.email must be an email address.`);
    result.email = email;
  }
  if (value.phone !== undefined) {
    const phone = text(value.phone, `${path}.phone`, limits.phoneMax, CONTROL);
    if (!PHONE.test(phone)) throw new StoreValidationError(`${path}.phone must contain digits, spaces, ( ) . - and a leading + only.`);
    result.phone = phone;
  }
  if (value.language !== undefined) {
    const language = text(value.language, `${path}.language`, limits.languageMax, CONTROL);
    if (!LANGUAGE.test(language)) throw new StoreValidationError(`${path}.language must be a BCP 47 language tag.`);
    result.language = language;
  }
  if (value.bookingReference !== undefined) {
    const reference = text(value.bookingReference, `${path}.bookingReference`, limits.bookingReferenceMax, CONTROL);
    if (!BOOKING_REFERENCE.test(reference)) throw new StoreValidationError(`${path}.bookingReference must contain letters, digits and . _ - only.`);
    result.bookingReference = reference;
  }
  if (value.notes !== undefined) result.notes = text(value.notes, `${path}.notes`, limits.notesMax, NOTES_CONTROL);
  return result;
}

export interface ExternalReservationKeyParts {
  readonly site: string;
  readonly externalAccountId: string;
  readonly externalReservationId: string;
}

/**
 * Keeps a reader's guest details for one reservation, in the ledger's transaction. A field the reader sent replaces
 * the kept one; a field it left out keeps what an earlier read said (sites hide some details after a while). Erased
 * details stay erased. Returns the name now kept, or null.
 */
export async function upsertExternalReservationGuest(
  client: PoolClient,
  key: ExternalReservationKeyParts,
  guest: ExternalReservationGuestDetails,
): Promise<string | null> {
  const result = await client.query<DbRow>(
    `INSERT INTO external_reservation_guests AS g
       (source_site,source_external_account_id,external_reservation_id,guest_name,party_breakdown,guest_email,guest_phone,
        guest_language,booking_reference,source_notes)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10)
     ON CONFLICT (source_site,source_external_account_id,external_reservation_id) DO UPDATE SET
       guest_name=COALESCE(EXCLUDED.guest_name,g.guest_name),
       party_breakdown=COALESCE(EXCLUDED.party_breakdown,g.party_breakdown),
       guest_email=COALESCE(EXCLUDED.guest_email,g.guest_email),
       guest_phone=COALESCE(EXCLUDED.guest_phone,g.guest_phone),
       guest_language=COALESCE(EXCLUDED.guest_language,g.guest_language),
       booking_reference=COALESCE(EXCLUDED.booking_reference,g.booking_reference),
       source_notes=COALESCE(EXCLUDED.source_notes,g.source_notes),
       updated_at=clock_timestamp()
     WHERE g.pii_erased_at IS NULL
     RETURNING guest_name`,
    [key.site, key.externalAccountId, key.externalReservationId, guest.name ?? null,
      guest.partyBreakdown === undefined ? null : JSON.stringify(guest.partyBreakdown), guest.email ?? null, guest.phone ?? null,
      guest.language ?? null, guest.bookingReference ?? null, guest.notes ?? null],
  );
  const name = result.rows[0]?.guest_name;
  return typeof name === "string" ? name : null;
}

/** The name kept for a reservation, or null (none given, or erased). */
export async function externalReservationGuestName(client: PoolClient, key: ExternalReservationKeyParts): Promise<string | null> {
  const result = await client.query<DbRow>(
    `SELECT guest_name FROM external_reservation_guests
      WHERE source_site=$1 AND source_external_account_id=$2 AND external_reservation_id=$3 AND pii_erased_at IS NULL`,
    [key.site, key.externalAccountId, key.externalReservationId],
  );
  const name = result.rows[0]?.guest_name;
  return typeof name === "string" ? name : null;
}

export class ExternalReservationGuests {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  /**
   * The mail job's erasure (#320, owner decision 2026-11-01): the guest details of external reservations whose
   * experience ended before `endedBefore` (a cancelled one: whose cancellation was read before it), up to `limit`.
   * One still in an open conflict case (staff may have to reach the guest) waits until the case is closed. The
   * ledger, its revisions and the inventory keep their 7 years; only these details go. A push's guest name that never
   * left the outbox (push off, or never sent) goes after 48 hours. The number of reservations erased.
   */
  async eraseGuestDetails(options: { readonly endedBefore: string; readonly limit?: number }): Promise<number> {
    assertCanonicalInstant(options.endedBefore, "endedBefore");
    const limit = options.limit ?? 1_000;
    if (!Number.isInteger(limit) || limit < 1 || limit > EXTERNAL_RESERVATION_GUEST_LIMITS.erasedPerRunMax) {
      throw new StoreValidationError(`limit must be from 1 to ${EXTERNAL_RESERVATION_GUEST_LIMITS.erasedPerRunMax}.`);
    }
    const result = await this.#pool.query<DbRow>(
      `WITH due AS (
         SELECT g.source_site, g.source_external_account_id, g.external_reservation_id
           FROM external_reservation_guests g
           JOIN external_reservations e ON e.source_site=g.source_site
            AND e.source_external_account_id=g.source_external_account_id AND e.external_reservation_id=g.external_reservation_id
          WHERE g.pii_erased_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM external_reservation_conflict_members m
                JOIN external_reservation_conflict_cases c ON c.id=m.case_id
               WHERE c.status='OPEN' AND m.member_kind='EXTERNAL' AND m.source_site=e.source_site
                 AND m.source_external_account_id=e.source_external_account_id AND m.external_reservation_id=e.external_reservation_id)
            AND CASE WHEN e.status='CANCELLED' THEN COALESCE((
                       SELECT min(r.created_at) FROM external_reservation_revisions r
                        WHERE r.source_site=e.source_site AND r.source_external_account_id=e.source_external_account_id
                          AND r.external_reservation_id=e.external_reservation_id AND r.local_revision=e.local_revision
                          AND r.disposition='APPLIED'), e.source_end_at)
                     ELSE e.source_end_at END
                < LEAST($1::timestamptz, clock_timestamp())
          ORDER BY g.source_site, g.source_external_account_id, g.external_reservation_id
          LIMIT $2
          FOR UPDATE OF g SKIP LOCKED
       ), erased AS (
         UPDATE external_reservation_guests g
            SET guest_name=NULL, party_breakdown=NULL, guest_email=NULL, guest_phone=NULL, guest_language=NULL,
                booking_reference=NULL, source_notes=NULL, pii_erased_at=clock_timestamp(), updated_at=clock_timestamp()
           FROM due
          WHERE g.source_site=due.source_site AND g.source_external_account_id=due.source_external_account_id
            AND g.external_reservation_id=due.external_reservation_id
          RETURNING g.source_site
       ), unsent AS (
         -- The topic is written out so that the partial index outbox_messages_ota_guest_name_idx applies.
         UPDATE outbox_messages SET payload = payload - 'guestName'
          WHERE topic='${HOST_NOTIFICATION_TOPICS.otaBooking}' AND payload ? 'guestName'
            AND created_at < clock_timestamp() - make_interval(hours => $3::integer)
       )
       SELECT count(*)::int AS erased FROM erased`,
      [options.endedBefore, limit, EXTERNAL_RESERVATION_GUEST_LIMITS.unsentNotificationHours],
    );
    return Number(result.rows[0]?.erased ?? 0);
  }
}
