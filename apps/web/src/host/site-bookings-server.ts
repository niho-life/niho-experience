import "server-only";
import {
  StoreAccessDeniedError,
  StoreConflictError,
  StoreNotFoundError,
  StoreValidationError,
  type BookingCancellations,
  type CancellationReason,
  type CancellationResult,
  type GuestBookingRepository,
  type HostActor,
  type HostGuestBooking,
  type HostGuestBookingPage,
} from "@niho-experience/experience-store";
import { config } from "@/lib/config";
import { sendRefunds, stripeRefundSubmitter } from "@/lib/experience/booking-refunds";
import { bookingCancellations, guestBookingRepository } from "@/lib/experience/store-server";
import type { HostProvider } from "@/lib/host/providers";
import { loadHostProviders, readHostSession } from "@/lib/host/server";
import { idTokenUsable } from "@/lib/host/session";
import type { BookingExperience } from "./bookings";
import { HOST_INVALID_INPUT_TEXT, HOST_SESSION_ENDED_TEXT } from "./errors";
import { todayInJapan, yen } from "./format";
import type { HostActionResult } from "./payout";
import { SITE_BOOKING_LOAD_FAILED_TEXT, siteBooking, siteBookingExperiences } from "./site-bookings";
import type { HostBooking } from "./types";

/*
 * 予約's bookings made on this site, kept in the experience DB (#285 slice 8, docs/guest-booking.md「ホストの画面」).
 * NIHO proves the account and that it is the provider's OWNER; the experience store checks its own OWNER
 * membership as well (ADR 0002), as 予約前の質問 does. Anyone else, or a deployment without
 * EXPERIENCE_GUEST_BOOKING_ENABLED and the DB, keeps today's screen. The guest's address never reaches the console.
 */

export const SITE_BOOKING_OWNER_ONLY_TEXT = "このサイトで受けた予約はオーナーが確認できます";

/** The list reads this many bookings: the upcoming ones from today, the nearest first, then the latest past ones. */
const LIST_LIMIT = 100;

/** NIHO said this account is the provider's OWNER; the store checks its own membership as well. */
export function ownerActor(providerId: string, nihoUserId: string): HostActor {
  return { providerId, nihoUserId, calendarRoleCeiling: "OWNER" };
}

/** The start of the day in Japan: the list's これから counts today's bookings, as the screen does (ホーム's 今日 too). */
export function startOfJapanDay(today: string): string {
  return new Date(`${today}T00:00:00+09:00`).toISOString();
}

/** One page as 予約 shows it. */
export interface HostSiteBookingPage {
  bookings: HostBooking[];
  experiences: BookingExperience[];
  /** 続きを見る reads the rest from here; null when every booking is on the list. */
  nextCursor: string | null;
}

function screenPage(bookings: readonly HostGuestBooking[], nextCursor: string | null): HostSiteBookingPage {
  return { bookings: bookings.map(siteBooking), experiences: siteBookingExperiences(bookings), nextCursor };
}

/**
 * Whether a booking made here has its messages with the guest (#285 slice 6b): open with the guest's booking page
 * (booking on this site and the mail job), where the guest reads and writes them.
 */
export function siteBookingMessagesEnabled(): boolean {
  return config.guestBookingEnabled && config.guestMailEnabled;
}

export type HostSiteBookingsLoad =
  | (HostSiteBookingPage & {
      status: "live";
      /** `?booking=` names none of the provider's bookings made here. */
      requestedMissing: boolean;
      today: string;
      /** Each booking leads to its messages with the guest (#285 slice 6b). */
      messages: boolean;
    })
  /** Not kept here for them: the flag is off, no DB, not the OWNER (NIHO or the experience DB). Today's screen. */
  | { status: "closed" }
  | { status: "error" };

/** 予約 for an OWNER (NIHO's role): the provider's bookings made here, with the one `?booking=` names among them. */
export async function loadSiteBookings(provider: HostProvider, nihoUserId: string, requestedBooking: string | null): Promise<HostSiteBookingsLoad> {
  const bookings = guestBookingRepository();
  if (!bookings || provider.memberRole !== "OWNER") return { status: "closed" };
  const actor = ownerActor(provider.id, nihoUserId);
  const today = todayInJapan(Date.now());
  try {
    const page = await bookings.listGuestBookingsForHost(actor, { from: startOfJapanDay(today), limit: LIST_LIMIT });
    const stored = [...page.bookings];
    let requestedMissing = false;
    if (requestedBooking && !stored.some((booking) => booking.publicBookingId === requestedBooking)) {
      try {
        stored.push(await bookings.getGuestBookingForHost(actor, requestedBooking));
      } catch (error) {
        if (!(error instanceof StoreNotFoundError || error instanceof StoreValidationError)) throw error;
        requestedMissing = true;
      }
    }
    return { status: "live", ...screenPage(stored, page.nextCursor), requestedMissing, today, messages: siteBookingMessagesEnabled() };
  } catch (error) {
    return error instanceof StoreAccessDeniedError ? { status: "closed" } : { status: "error" };
  }
}

/**
 * Beside NIHO's bookings (provider operations): how many bookings were made here, for the notice that leads to
 * them. 0 when none, or while they are not shown to this account; a failure to count shows no notice either
 * (NIHO's list is the screen).
 */
export async function countSiteBookings(provider: HostProvider, nihoUserId: string): Promise<number> {
  const bookings = guestBookingRepository();
  if (!bookings || provider.memberRole !== "OWNER") return 0;
  try {
    return await bookings.countGuestBookingsForHost(ownerActor(provider.id, nihoUserId));
  } catch {
    return 0;
  }
}

type OwnerCheck = { ok: true; bookings: GuestBookingRepository; actor: HostActor } | { ok: false; message: string };

/** A usable session, the store, and NIHO saying this account owns the provider. */
export async function asOwner(providerId: string): Promise<OwnerCheck> {
  const session = await readHostSession();
  if (!session || !idTokenUsable(session, Date.now())) return { ok: false, message: HOST_SESSION_ENDED_TEXT };
  const bookings = guestBookingRepository();
  if (!bookings) return { ok: false, message: SITE_BOOKING_LOAD_FAILED_TEXT };
  const providers = await loadHostProviders();
  if (providers.status !== "ok") return { ok: false, message: providers.status === "error" ? SITE_BOOKING_LOAD_FAILED_TEXT : HOST_SESSION_ENDED_TEXT };
  const provider = providers.providers.find((entry) => entry.id === providerId);
  if (provider?.memberRole !== "OWNER") return { ok: false, message: SITE_BOOKING_OWNER_ONLY_TEXT };
  return { ok: true, bookings, actor: ownerActor(providerId, session.nihoUserId) };
}

/** 続きを見る: the bookings after the list's last one, from the cursor the previous page gave (it keeps that page's today). */
export async function loadMoreSiteBookings(providerId: string, cursor: string): Promise<HostActionResult<HostSiteBookingPage>> {
  const owner = await asOwner(providerId);
  if (!owner.ok) return owner;
  try {
    const page: HostGuestBookingPage = await owner.bookings.listGuestBookingsForHost(owner.actor, { cursor, limit: LIST_LIMIT });
    return { ok: true, message: "", ...screenPage(page.bookings, page.nextCursor) };
  } catch (error) {
    if (error instanceof StoreAccessDeniedError) return { ok: false, message: SITE_BOOKING_OWNER_ONLY_TEXT };
    if (error instanceof StoreValidationError) return { ok: false, message: HOST_INVALID_INPUT_TEXT };
    return { ok: false, message: SITE_BOOKING_LOAD_FAILED_TEXT };
  }
}

export const SITE_CANCEL_FAILED_TEXT = "取り消せませんでした。時間をおいて、もう一度お試しください。";
export const SITE_CANCEL_NOT_CANCELLABLE_TEXT = "この予約は取り消せません。すでに取り消されているか、NIHO サポートが対応中です。";
const SITE_CANCEL_CONFLICT_TEXT = "画面を開き直して、もう一度お試しください。";

export interface SiteCancelInput {
  commandId: string;
  reason: CancellationReason;
  /** The host's own note (never sent to the guest); empty for none. */
  note: string;
}

/** 取消 by the OWNER (#285 slice 7): the store's command, then the refunds to Stripe. A refund Stripe cannot take now stays requested. */
export async function runOwnerCancellation(
  providerId: string,
  run: (cancellations: BookingCancellations, actor: HostActor) => Promise<CancellationResult>,
): Promise<{ ok: true; result: CancellationResult; bookings: GuestBookingRepository; actor: HostActor } | { ok: false; message: string }> {
  const owner = await asOwner(providerId);
  if (!owner.ok) return owner;
  const cancellations = bookingCancellations();
  if (!cancellations) return { ok: false, message: SITE_CANCEL_FAILED_TEXT };
  let result: CancellationResult;
  try {
    result = await run(cancellations, owner.actor);
  } catch (error) {
    if (error instanceof StoreAccessDeniedError) return { ok: false, message: SITE_BOOKING_OWNER_ONLY_TEXT };
    if (error instanceof StoreValidationError) return { ok: false, message: HOST_INVALID_INPUT_TEXT };
    if (error instanceof StoreNotFoundError) return { ok: false, message: SITE_BOOKING_LOAD_FAILED_TEXT };
    if (error instanceof StoreConflictError) return { ok: false, message: SITE_CANCEL_CONFLICT_TEXT };
    console.error("Experience host cancellation failed", { error: error instanceof Error ? error.name : typeof error });
    return { ok: false, message: SITE_CANCEL_FAILED_TEXT };
  }
  await sendRefunds(result.refunds, { cancellations, submit: stripeRefundSubmitter() });
  return { ok: true, result, bookings: owner.bookings, actor: owner.actor };
}

/**
 * 予約 › 取り消して全額を返金する (#285 slice 7): the OWNER cancels one booking made here; the guest gets the whole
 * payment back (the host's decision) and an email. Answers the booking as the store has it now.
 */
export async function cancelSiteBookingAsOwner(providerId: string, bookingId: string, input: SiteCancelInput): Promise<HostActionResult<{ booking: HostBooking }>> {
  const done = await runOwnerCancellation(providerId, (cancellations, actor) => cancellations.cancelAsHost(actor, bookingId, input));
  if (!done.ok) return done;
  let booking: HostBooking;
  try {
    booking = siteBooking(await done.bookings.getGuestBookingForHost(done.actor, bookingId));
  } catch {
    return { ok: false, message: SITE_BOOKING_LOAD_FAILED_TEXT };
  }
  if (done.result.outcome !== "CANCELLED") return { ok: true, message: SITE_CANCEL_NOT_CANCELLABLE_TEXT, booking };
  return { ok: true, message: `予約を取り消しました。予約者に ${yen(booking.amountYen)} を全額返金します`, booking };
}
