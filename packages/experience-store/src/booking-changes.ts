import { createHash, randomUUID } from "node:crypto";
import {
  addLocalDays,
  assertLocalDate,
  createBookingOccurrenceSnapshot,
  findOverlappingOpenOccurrenceIds,
  type AvailabilityReason,
} from "@niho-experience/experience-domain";
import type { Pool, PoolClient } from "pg";
import { BOOKING_ACCESS_LIMITS, sessionBookingRef } from "./booking-access.ts";
import { GUEST_NOTICE_TOPICS } from "./booking-cancellations.ts";
import { cancellationTermsOf, freeCancellationDeadlineUtc } from "./cancellation-terms.ts";
import { StoreConflictError, StoreError, StoreNotFoundError, StoreValidationError } from "./errors.ts";
import {
  activeRules,
  expandRules,
  GUEST_BOOKING_LIMITS,
  GuestBookingRepository,
  loadSellable,
  offerPricesMatchActiveRules,
  tokyoDate,
} from "./guest-bookings.ts";
import { enqueueBookingChangedNotification } from "./host-notification-outbox.ts";
import { evaluateStoredInventory, lockProviderInventory } from "./inventory.ts";
import { enqueueCalendarRecalculation } from "./inventory-outbox.ts";
import { materializeAndLockOccurrence, requireMembership } from "./repository.ts";
import { isoValue, type DbRow } from "./rows.ts";
import { withTransaction } from "./transaction.ts";
import type { HostActor } from "./types.ts";
import { assertCanonicalInstant, assertStoreIdentifier } from "./validation.ts";

/*
 * 予約の日時変更 (#720 stage 1, migration 0094, docs/guest-booking.md「予約の日時変更（#720）」): the guest moves their confirmed
 * booking, from its booking page (slice 6's session), to another occurrence of the same offer (`occurrence_snapshot.ruleId`),
 * with the same party and the same price. Nothing about the payment changes: this module never calls Stripe and never reads or
 * writes the ledger, refunds or the pricing snapshot (beyond reading what the booking fixed). The booking row keeps its
 * identity; only its occurrence and occurrence snapshot move, through the one exception of the snapshot trigger (the
 * transaction-local `experience.booking_move` naming this booking's row). Every move is one command (a UUID), whose first
 * result the same command gets again, and one row of `booking_changes` (no personal data).
 *
 * Stage 1 leaves out, on purpose: bookings that occupy a shared resource (their occupancy rows are append-only per booking,
 * so moving the booking alone would leave a ghost occupancy behind), approval (APPROVAL) and NIHO-managed (MANAGED_20)
 * bookings, and the host's and support's side (stage 2).
 */

export type BookingChangeOutcome =
  /** Moved: the booking is on the new date. */
  | "OK"
  /** What the page showed is no longer so (the booking's time, the new date's time or its new deadline); nothing changed. */
  | "CHANGED"
  /** The new date has no room for the party any more; nothing changed. */
  | "FULL"
  /** This booking cannot be moved (by its terms, its state or the date asked for); nothing changed. */
  | "NOT_CHANGEABLE";

export interface GuestBookingChangeInput {
  readonly commandId: string;
  /** The new date, YYYY-MM-DD in Japan (as the public availability and checkout name it). */
  readonly toDate: string;
  /** The booking's start the page showed. */
  readonly shownFromStartUtc: string;
  /** The new date's start the page showed. */
  readonly shownToStartUtc: string;
  /** The new free-cancellation deadline the page showed. */
  readonly shownNewDeadlineUtc: string;
}

export interface BookingChangeResult {
  readonly outcome: BookingChangeOutcome;
  /** The same command again: what it did the first time. */
  readonly repeated: boolean;
  /** The move's number for this booking (1, 2 …), when it moved. */
  readonly changeNumber?: number;
  /**
   * The end of the guest's booking-page session after the move (it is extended to 30 days past the new end), for a guest
   * change that went through (also the same command again): the page sets its cookie to this, or the browser would drop it
   * at the old end. Absent for any other outcome.
   */
  readonly sessionExpiresAtUtc?: string;
}

/** One date the booking may move to, as the page offers it. */
export interface BookingChangeOption {
  readonly date: string;
  readonly startAtUtc: string;
  readonly endAtUtc: string;
  readonly seatsLeft: number;
  /** The free-cancellation deadline the booking would have on that date. */
  readonly newDeadlineUtc: string;
}

export type BookingChangeOptions =
  | { readonly changeable: false }
  | {
      readonly changeable: true;
      readonly fromStartUtc: string;
      readonly changesUsed: number;
      readonly maxChanges: number;
      /** Nearest first; empty when no other date has room now. */
      readonly options: readonly BookingChangeOption[];
    };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const LOCK_COMMAND = 47;
const MEETING_GUIDE_KEY = "meeting-guide-day-before:";
/** Availability answers that mean the date has no room for the party (the rest: the date is closed or not on sale). */
const FULL_REASONS: ReadonlySet<AvailabilityReason> = new Set(["INSUFFICIENT_CAPACITY", "GROUP_RESERVED"]);

const fingerprint = (parts: readonly unknown[]): string => createHash("sha256").update(JSON.stringify(parts), "utf8").digest("hex");
const record = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {});

function text(value: unknown, key: string): string {
  if (typeof value !== "string" || value.length === 0) throw new StoreError(`Database returned an invalid ${key}.`);
  return value;
}

function count(value: unknown, key: string): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new StoreError(`Database returned an invalid ${key}.`);
  return parsed;
}

function validInput(input: GuestBookingChangeInput): GuestBookingChangeInput {
  if (typeof input?.commandId !== "string" || !UUID.test(input.commandId)) throw new StoreValidationError("commandId must be a UUID.");
  if (typeof input.toDate !== "string" || !LOCAL_DATE.test(input.toDate)) throw new StoreValidationError("toDate must be a YYYY-MM-DD date.");
  try {
    assertLocalDate(input.toDate, "toDate");
  } catch (error) {
    throw new StoreValidationError("toDate must be a YYYY-MM-DD date.", { cause: error });
  }
  assertCanonicalInstant(input.shownFromStartUtc, "shownFromStartUtc");
  assertCanonicalInstant(input.shownToStartUtc, "shownToStartUtc");
  assertCanonicalInstant(input.shownNewDeadlineUtc, "shownNewDeadlineUtc");
  return { ...input, commandId: input.commandId.toLowerCase() };
}

/* ---------- the booking ---------- */

/** The booking as this module reads it: always a guest booking (a booking_guests row), with the slug it is sold under. */
const BOOKING = `
  SELECT b.id::text AS id, b.provider_id, b.public_booking_id::text AS public_booking_id, b.product_id, b.occurrence_id, b.status, b.seats,
         b.occurrence_snapshot, b.pricing_snapshot, b.seller_snapshot, (g.adult_count + g.child_count) AS party, p.public_title,
         pub.slug AS sale_slug, clock_timestamp() AS db_now
    FROM bookings b
    JOIN booking_guests g ON g.provider_id = b.provider_id AND g.booking_id = b.id
    JOIN experience_products p ON p.provider_id = b.provider_id AND p.id = b.product_id
    LEFT JOIN experience_product_publication_states s ON s.provider_id = b.provider_id AND s.product_id = b.product_id
    LEFT JOIN experience_product_publications pub ON pub.id = s.booking_publication_id`;

interface ChangeBooking {
  readonly rowId: string;
  readonly providerId: string;
  readonly publicBookingId: string;
  readonly productId: string;
  readonly occurrenceId: string;
  readonly occurrenceSnapshot: Record<string, unknown>;
  readonly status: string;
  readonly seats: number;
  readonly party: number;
  readonly ruleId: string;
  readonly startUtc: string;
  readonly endUtc: string;
  readonly acceptedAtUtc: string;
  readonly windowMinutes: number | null;
  readonly deadlineUtc: string | null;
  readonly maxChanges: number | null;
  readonly approval: boolean;
  readonly managed20: boolean;
  readonly title: string;
  readonly saleSlug: string | null;
  readonly nowUtc: string;
}

function bookingFromRow(row: DbRow): ChangeBooking {
  const occurrence = record(row.occurrence_snapshot);
  const pricing = record(row.pricing_snapshot);
  const seller = record(row.seller_snapshot);
  const startUtc = text(occurrence.startUtc, "occurrence_snapshot.startUtc");
  const windowMinutes = cancellationTermsOf(pricing).cancellationWindowMinutesBeforeStart;
  const change = record(pricing.guestChange);
  const maxChanges = change.allowed === true && Number.isSafeInteger(change.maxChanges) && Number(change.maxChanges) >= 1 ? Number(change.maxChanges) : null;
  return {
    rowId: text(row.id, "id"),
    providerId: text(row.provider_id, "provider_id"),
    publicBookingId: text(row.public_booking_id, "public_booking_id"),
    productId: text(row.product_id, "product_id"),
    occurrenceId: text(row.occurrence_id, "occurrence_id"),
    occurrenceSnapshot: occurrence,
    status: text(row.status, "status"),
    seats: count(row.seats, "seats"),
    party: count(row.party, "party"),
    ruleId: text(occurrence.ruleId, "occurrence_snapshot.ruleId"),
    startUtc,
    endUtc: text(occurrence.endUtc, "occurrence_snapshot.endUtc"),
    acceptedAtUtc: text(occurrence.acceptedAtUtc, "occurrence_snapshot.acceptedAtUtc"),
    windowMinutes,
    deadlineUtc: freeCancellationDeadlineUtc(startUtc, windowMinutes),
    maxChanges,
    approval: seller.acceptanceMode === "APPROVAL",
    managed20: seller.chargeMode === "PLATFORM" && seller.salesPlan === "MANAGED_20",
    title: text(row.public_title, "public_title"),
    saleSlug: typeof row.sale_slug === "string" && row.sale_slug.length > 0 ? row.sale_slug : null,
    nowUtc: isoValue(row, "db_now"),
  };
}

async function readBooking(client: PoolClient, providerId: string, rowId: string, lock: boolean): Promise<ChangeBooking | null> {
  const found = await client.query<DbRow>(`${BOOKING} WHERE b.provider_id = $1 AND b.id = $2${lock ? " FOR UPDATE OF b" : ""}`, [providerId, rowId]);
  return found.rows[0] ? bookingFromRow(found.rows[0]) : null;
}

/**
 * Whether the booking may be moved now, as far as the booking itself says (the target date is checked apart): confirmed,
 * neither an approval nor a NIHO-managed booking, `guestChange` fixed at booking, before its free-cancellation deadline, under
 * its number of moves, no open request to cancel and no refund at all, no shared-resource occupancy, and its day-before
 * meeting email (when it has one) not sent yet. Returns the moves so far, or null when it may not be moved.
 */
async function changesSoFarIfChangeable(client: PoolClient, booking: ChangeBooking): Promise<number | null> {
  if (booking.status !== "CONFIRMED" || booking.approval || booking.managed20 || booking.maxChanges === null) return null;
  if (booking.seats !== booking.party || booking.deadlineUtc === null) return null;
  if (!(booking.deadlineUtc > booking.nowUtc) || !(booking.startUtc > booking.nowUtc)) return null;
  const facts = await client.query<DbRow>(
    `SELECT (SELECT count(*) FROM booking_changes WHERE provider_id = $1 AND booking_id = $2)::int AS changes,
            EXISTS (SELECT 1 FROM booking_cancellation_requests WHERE provider_id = $1 AND booking_id = $2 AND status = 'OPEN') AS open_request,
            EXISTS (SELECT 1 FROM booking_refunds WHERE provider_id = $1 AND booking_id = $2) AS refunded,
            EXISTS (SELECT 1 FROM booking_resource_occupancies WHERE provider_id = $1 AND booking_id = $2) AS occupies,
            EXISTS (SELECT 1 FROM outbox_messages WHERE provider_id = $1 AND deduplication_key = $3
                     AND (processed_at IS NOT NULL OR attempts > 0 OR available_at <= clock_timestamp())) AS guide_sent`,
    [booking.providerId, booking.rowId, `${MEETING_GUIDE_KEY}${booking.publicBookingId}`],
  );
  const row = facts.rows[0]!;
  const changes = count(row.changes, "changes");
  if (changes >= booking.maxChanges || row.open_request === true || row.refunded === true || row.occupies === true || row.guide_sent === true) return null;
  return changes;
}

/* ---------- commands ---------- */

interface CommandKey {
  readonly commandId: string;
  readonly providerId: string;
  readonly fingerprint: string;
}

interface StoredChangeResult {
  readonly outcome: BookingChangeOutcome;
  readonly changeNumber?: number;
}

const OUTCOMES: ReadonlySet<string> = new Set(["OK", "CHANGED", "FULL", "NOT_CHANGEABLE"]);

async function previousResult(client: PoolClient, key: CommandKey): Promise<StoredChangeResult | null> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, $2))", [`booking-change-command:${key.commandId}`, LOCK_COMMAND]);
  const found = await client.query<DbRow>(
    "SELECT provider_id, actor_kind, actor_ref, action, request_fingerprint, result FROM booking_change_commands WHERE command_id = $1::uuid",
    [key.commandId],
  );
  const row = found.rows[0];
  if (!row) return null;
  if (row.provider_id !== key.providerId || row.actor_kind !== "GUEST" || row.actor_ref !== null
    || row.action !== "GUEST_CHANGE" || row.request_fingerprint !== key.fingerprint) {
    throw new StoreConflictError("The command ID was already used with different input.");
  }
  const result = record(row.result);
  if (typeof result.outcome !== "string" || !OUTCOMES.has(result.outcome)) throw new StoreError("Database returned an invalid command result.");
  return {
    outcome: result.outcome as BookingChangeOutcome,
    ...(Number.isSafeInteger(result.changeNumber) ? { changeNumber: Number(result.changeNumber) } : {}),
  };
}

async function recordResult(client: PoolClient, key: CommandKey, result: StoredChangeResult & { readonly changeId?: string }): Promise<void> {
  await client.query(
    `INSERT INTO booking_change_commands (command_id, provider_id, actor_kind, actor_ref, action, request_fingerprint, result)
     VALUES ($1::uuid, $2, 'GUEST', NULL, 'GUEST_CHANGE', $3, $4::jsonb)`,
    [key.commandId, key.providerId, key.fingerprint, JSON.stringify(result)],
  );
}

/* ---------- the repository ---------- */

export class BookingChanges {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  /**
   * Whether the booking page may show "Change date": the booking's own facts only (as `listChangeOptions`' `changeable`),
   * without reading the dates, so the page's render stays light. False when the session cannot open this booking.
   */
  async isChangeable(sessionId: string, publicBookingId: string): Promise<boolean> {
    return withTransaction(this.#pool, async (client) => {
      const located = await sessionBookingRef(client, sessionId, publicBookingId);
      if (!located) return false;
      const booking = await readBooking(client, located.providerId, located.bookingId, false);
      return booking !== null && await changesSoFarIfChangeable(client, booking) !== null;
    });
  }

  /**
   * What the guest's booking page offers: null when the session cannot open this booking (the caller answers as for a
   * booking it cannot open); `changeable: false` when the booking may not be moved; otherwise the booking's start, its
   * moves so far and allowed, and the dates of the same offer with room for the whole party (from today through 89 days,
   * as the public availability), other than its own, whose new free-cancellation deadline is still ahead. Nothing personal.
   */
  async listChangeOptions(sessionId: string, publicBookingId: string): Promise<BookingChangeOptions | null> {
    const read = await withTransaction(this.#pool, async (client) => {
      const located = await sessionBookingRef(client, sessionId, publicBookingId);
      if (!located) return null;
      const booking = await readBooking(client, located.providerId, located.bookingId, false);
      if (!booking) return null;
      return { booking, changes: await changesSoFarIfChangeable(client, booking) };
    });
    if (!read) return null;
    const { booking, changes } = read;
    if (changes === null) return { changeable: false };
    const answer = { changeable: true as const, fromStartUtc: booking.startUtc, changesUsed: changes, maxChanges: booking.maxChanges! };
    const availability = booking.saleSlug === null
      ? null
      : await new GuestBookingRepository(this.#pool).listPublicAvailability(booking.saleSlug, { offerId: booking.ruleId });
    if (!availability) return { ...answer, options: [] };
    const options: BookingChangeOption[] = [];
    for (const occurrence of availability.occurrences) {
      if (occurrence.offerId !== booking.ruleId || !occurrence.bookable || occurrence.seatsLeft < booking.party) continue;
      if (occurrence.startAt === booking.startUtc) continue;
      const newDeadlineUtc = freeCancellationDeadlineUtc(occurrence.startAt, booking.windowMinutes);
      if (newDeadlineUtc === null || !(newDeadlineUtc > availability.generatedAt)) continue;
      options.push({ date: occurrence.date, startAtUtc: occurrence.startAt, endAtUtc: occurrence.endAt, seatsLeft: occurrence.seatsLeft, newDeadlineUtc });
    }
    return { ...answer, options };
  }

  /**
   * The guest's "Change date" from their booking page. Under the provider inventory lock, with the booking row locked, the
   * booking, its terms and the new date are read again: when the page showed something no longer so, nothing changes and the
   * outcome is CHANGED; a date without room for the party is FULL; anything else this booking or date does not allow is
   * NOT_CHANGEABLE. A move puts the booking on the new occurrence (its seats leave the old one), keeps its price and payment,
   * records the move, and in the same transaction: both occurrences' recalculation, the guest's email, the host's push, the
   * day-before meeting email moved to the new date, and the booking page's sessions kept open until 30 days after the new end.
   * null when the session cannot act on this booking. The same command returns its first result (`repeated`).
   */
  async changeAsGuest(sessionId: string, publicBookingId: string, rawInput: GuestBookingChangeInput): Promise<BookingChangeResult | null> {
    const input = validInput(rawInput);
    const located = await withTransaction(this.#pool, (client) => sessionBookingRef(client, sessionId, publicBookingId));
    if (!located) return null;
    const result = await withTransaction(this.#pool, async (client) => {
      await lockProviderInventory(client, located.providerId);
      // The session is checked again under the lock: signed out or revoked meanwhile is null as before.
      const session = await sessionBookingRef(client, sessionId, publicBookingId);
      if (!session || session.bookingId !== located.bookingId) return null;
      // The input alone: a retry after a move finds the booking on its new date, and must still be the same command.
      const key: CommandKey = {
        commandId: input.commandId,
        providerId: located.providerId,
        fingerprint: fingerprint([
          "GUEST_CHANGE", publicBookingId.toLowerCase(), input.toDate, input.shownFromStartUtc, input.shownToStartUtc, input.shownNewDeadlineUtc,
        ]),
      };
      const previous = await previousResult(client, key);
      if (previous) return { ...previous, repeated: true };
      const booking = await readBooking(client, located.providerId, located.bookingId, true);
      if (!booking) return null;
      const done = async (outcome: BookingChangeOutcome, moved?: { changeNumber: number; changeId: string }): Promise<BookingChangeResult> => {
        await recordResult(client, key, { outcome, ...(moved ?? {}) });
        return { outcome, repeated: false, ...(moved ? { changeNumber: moved.changeNumber } : {}) };
      };

      const changes = await changesSoFarIfChangeable(client, booking);
      if (changes === null) return done("NOT_CHANGEABLE");
      if (input.shownFromStartUtc !== booking.startUtc) return done("CHANGED");

      // The new date: the same offer, in the public window, exactly one occurrence that day (as checkout names it).
      const today = tokyoDate(booking.nowUtc);
      if (input.toDate < today || input.toDate > addLocalDays(today, GUEST_BOOKING_LIMITS.windowDays - 1)) return done("NOT_CHANGEABLE");
      const sellable = booking.saleSlug === null ? null : await loadSellable(client, booking.saleSlug, true);
      if (!sellable || sellable.product.providerId !== booking.providerId || sellable.product.id !== booking.productId) return done("NOT_CHANGEABLE");
      const rules = await activeRules(client, booking.providerId, booking.productId, today);
      if (!await offerPricesMatchActiveRules(client, sellable.terms, booking.providerId, booking.productId, today)) return done("NOT_CHANGEABLE");
      const rule = rules.find((stored) => stored.rule.id === booking.ruleId);
      if (!rule) return done("NOT_CHANGEABLE");
      const candidates = await expandRules(client, booking.providerId, [rule], input.toDate, input.toDate);
      if (candidates.length !== 1) return done("NOT_CHANGEABLE");
      const target = candidates[0]!.occurrence;
      const previousDate = await expandRules(client, booking.providerId, rules, addLocalDays(input.toDate, -1), addLocalDays(input.toDate, -1));
      const sameDate = await expandRules(client, booking.providerId, rules, input.toDate, input.toDate);
      if (findOverlappingOpenOccurrenceIds([...previousDate, ...sameDate].map((item) => item.occurrence)).has(target.id)) return done("NOT_CHANGEABLE");
      if (target.id === booking.occurrenceId) return done("NOT_CHANGEABLE");
      const newDeadlineUtc = freeCancellationDeadlineUtc(target.startUtc, booking.windowMinutes);
      if (input.shownToStartUtc !== target.startUtc || input.shownNewDeadlineUtc !== newDeadlineUtc) return done("CHANGED");
      // The date's free cancellation would already be over: the page offered it before it ended.
      if (newDeadlineUtc === null || !(newDeadlineUtc > booking.nowUtc)) return done("CHANGED");

      const occurrence = await materializeAndLockOccurrence(client, booking.providerId, booking.productId, target.id);
      const inventory = await evaluateStoredInventory(client, booking.providerId, booking.productId, occurrence, booking.nowUtc, booking.seats);
      // A product that occupies a shared resource is not moved in stage 1 (its occupancy rows are append-only per booking).
      if (inventory.occupancies.length > 0) return done("NOT_CHANGEABLE");
      if (!inventory.availability.bookable) return done(FULL_REASONS.has(inventory.availability.reason) ? "FULL" : "NOT_CHANGEABLE");

      // The day-before meeting email (when the booking has one) is locked against the mail job's claim before anything moves:
      // the job claims with SKIP LOCKED in its own transaction and sends from what it read, so a row already sent, claimed
      // (attempts > 0, its lease running) or due would still go out for the old date. Such a booking is not moved.
      const guide = await client.query<DbRow>(
        `SELECT id::text AS id, (processed_at IS NOT NULL OR attempts > 0 OR available_at <= clock_timestamp()) AS settled
           FROM outbox_messages WHERE provider_id = $1 AND deduplication_key = $2 FOR UPDATE`,
        [booking.providerId, `${MEETING_GUIDE_KEY}${booking.publicBookingId}`],
      );
      if (guide.rows[0]?.settled === true) return done("NOT_CHANGEABLE");
      const guideRowId = guide.rows[0] ? text(guide.rows[0].id, "outbox id") : null;

      const toSnapshot = createBookingOccurrenceSnapshot(occurrence, booking.seats, booking.acceptedAtUtc);
      await client.query("SELECT set_config('experience.booking_move', $1, true)", [booking.rowId]);
      await client.query(
        `UPDATE bookings SET occurrence_id = $3, occurrence_snapshot = $4::jsonb, updated_at = clock_timestamp()
          WHERE provider_id = $1 AND id = $2`,
        [booking.providerId, booking.rowId, occurrence.id, JSON.stringify(toSnapshot)],
      );
      await client.query("SELECT set_config('experience.booking_move', '', true)");
      const changeId = randomUUID();
      const changeNumber = changes + 1;
      await client.query(
        `INSERT INTO booking_changes
           (id, provider_id, booking_id, change_number, command_id, from_occurrence_id, to_occurrence_id, from_snapshot, to_snapshot, changed_by)
         VALUES ($1::uuid, $2, $3, $4, $5::uuid, $6, $7, $8::jsonb, $9::jsonb, 'GUEST')`,
        [changeId, booking.providerId, booking.rowId, changeNumber, input.commandId, booking.occurrenceId, occurrence.id,
          JSON.stringify(booking.occurrenceSnapshot), JSON.stringify(toSnapshot)],
      );

      // Seats leave the old occurrence and take the new one: the calendar and channels recalculate both.
      for (const aggregateId of [booking.occurrenceId, occurrence.id]) {
        await enqueueCalendarRecalculation(client, { providerId: booking.providerId, aggregateType: "schedule_occurrence", aggregateId, cause: "booking_changed" });
      }
      // The guest's email: IDs only; the mail job reads the booking and the move when it sends it.
      await client.query(
        `INSERT INTO outbox_messages (provider_id, aggregate_type, aggregate_id, topic, deduplication_key, payload)
         VALUES ($1, 'booking', $2, $3, $4, $5::jsonb)
         ON CONFLICT (provider_id, deduplication_key) DO NOTHING`,
        [booking.providerId, booking.publicBookingId, GUEST_NOTICE_TOPICS.changed, `guest-mail:changed:${changeId}`,
          JSON.stringify({ publicBookingId: booking.publicBookingId, changeId })],
      );
      await enqueueBookingChangedNotification(client, {
        providerId: booking.providerId, bookingId: booking.publicBookingId, experienceTitle: booking.title,
        startsAt: occurrence.startUtc, previousStartsAt: booking.startUtc, seats: Math.max(1, booking.party), changeId,
      });
      // The day-before meeting email (when the booking has one, locked above) goes the day before the new date.
      if (guideRowId !== null) {
        await client.query(
          "UPDATE outbox_messages SET available_at = GREATEST(clock_timestamp(), $2::timestamptz - interval '24 hours') WHERE id = $1::bigint",
          [guideRowId, occurrence.startUtc],
        );
      }
      // The booking page stays open on this device until 30 days after the new end (never shorter than it was).
      await client.query(
        `UPDATE booking_sessions s
            SET absolute_expires_at = GREATEST(s.absolute_expires_at, $3::timestamptz + make_interval(days => $4)),
                idle_expires_at = LEAST(s.idle_expires_at, GREATEST(s.absolute_expires_at, $3::timestamptz + make_interval(days => $4)))
          WHERE s.provider_id = $1 AND s.booking_id = $2 AND s.revoked_at IS NULL
            AND s.idle_expires_at > clock_timestamp() AND s.absolute_expires_at > clock_timestamp()`,
        [booking.providerId, booking.rowId, occurrence.endUtc, BOOKING_ACCESS_LIMITS.daysAfterExperience],
      );
      return done("OK", { changeNumber, changeId });
    });
    if (!result || result.outcome !== "OK") return result;
    // The session now ends where the move put it (after the commit, so a repeat of the same command reads the same end).
    const after = await withTransaction(this.#pool, (client) => sessionBookingRef(client, sessionId, publicBookingId));
    return after ? { ...result, sessionExpiresAtUtc: after.absoluteExpiresAtUtc } : result;
  }

  /**
   * The product's switch for guest changes (stage 2 gives the OWNER a screen for it). It decides only bookings made after it:
   * a booking fixes `guestChange` when it is made. The OWNER of the product's provider only.
   */
  async setGuestChangeAllowed(actor: HostActor, productId: string, allowed: boolean): Promise<void> {
    assertStoreIdentifier(productId, "productId");
    if (typeof allowed !== "boolean") throw new StoreValidationError("allowed must be true or false.");
    await withTransaction(this.#pool, async (client) => {
      await requireMembership(client, actor, ["OWNER"]);
      const product = await client.query("SELECT 1 FROM experience_products WHERE provider_id = $1 AND id = $2", [actor.providerId, productId]);
      if (product.rowCount === 0) throw new StoreNotFoundError("product");
      await client.query(
        `INSERT INTO product_guest_change_settings (provider_id, product_id, allowed) VALUES ($1, $2, $3)
         ON CONFLICT (provider_id, product_id) DO UPDATE SET allowed = EXCLUDED.allowed, updated_at = clock_timestamp()`,
        [actor.providerId, productId, allowed],
      );
    });
  }
}
