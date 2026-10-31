import "server-only";
import { StoreAccessDeniedError, StoreValidationError } from "@niho-experience/experience-store";
import { guestBookingRepository } from "@/lib/experience/store-server";
import type { HostProvider } from "@/lib/host/providers";
import { actionTime, type SessionQuery } from "./bookings";
import type { HostSessionView } from "./console-data";
import { todayInJapan } from "./format";
import { ownerActor, startOfJapanDay } from "./site-bookings-server";
import { siteHomeSessions, siteHomeTodos, siteSessionView, type SiteHome } from "./site-sessions";

/*
 * ホーム and この回 for the bookings made on this site, kept in the experience DB (#285 slice 8b,
 * docs/guest-booking.md「ホストの画面」). As 予約's (site-bookings-server.ts): NIHO proves the account and that it is
 * the provider's OWNER, the experience store checks its own OWNER membership as well (ADR 0002), and anyone else,
 * or a deployment without EXPERIENCE_GUEST_BOOKING_ENABLED and the DB, keeps today's screen. The guest's address
 * never reaches the console; their phone reaches この回 only.
 */

/** ホーム reads this many sessions from today: today's and tomorrow's, and the few after them it shows. */
const HOME_SESSION_LIMIT = 100;

export type HostSiteHomeLoad =
  | (SiteHome & { status: "live" })
  /** Not kept here for them: the flag is off, no DB, not the OWNER (NIHO or the experience DB). Today's screen. */
  | { status: "closed" }
  | { status: "error" };

/**
 * ホーム for an OWNER (NIHO's role): the provider's sessions with guests from this site from the start of today in
 * Japan, and 次にすること for the payments under review. `besideNiho`: NIHO's bookings are 予約's own (provider
 * operations), so the rows say they are this site's and lead to この回 with `?source=site`.
 */
export async function loadSiteHome(provider: HostProvider, nihoUserId: string, besideNiho: boolean): Promise<HostSiteHomeLoad> {
  const bookings = guestBookingRepository();
  if (!bookings || provider.memberRole !== "OWNER") return { status: "closed" };
  const now = Date.now();
  const today = todayInJapan(now);
  try {
    const sessions = await bookings.listGuestSessionsForHost(ownerActor(provider.id, nihoUserId), { from: startOfJapanDay(today), limit: HOME_SESSION_LIMIT });
    return { status: "live", sessions: siteHomeSessions(sessions, actionTime(today, now), besideNiho), todos: siteHomeTodos(sessions, besideNiho) };
  } catch (error) {
    return error instanceof StoreAccessDeniedError ? { status: "closed" } : { status: "error" };
  }
}

export type HostSiteSessionLoad =
  | {
      status: "live";
      /** null when the session has none of the provider's bookings made here (another provider's, or none at all). */
      session: HostSessionView | null;
      /** YYYY-MM-DDTHH:MM in Japan: whether the session has started. */
      now: string;
    }
  | { status: "closed" }
  | { status: "error" };

/** この回 for an OWNER (NIHO's role): this site's bookings for the session `?date=&start=&experience=&offer=` names. */
export async function loadSiteSession(provider: HostProvider, nihoUserId: string, query: SessionQuery): Promise<HostSiteSessionLoad> {
  const bookings = guestBookingRepository();
  if (!bookings || provider.memberRole !== "OWNER") return { status: "closed" };
  const clock = Date.now();
  const now = actionTime(todayInJapan(clock), clock);
  try {
    const stored = await bookings.listGuestBookingsForSession(ownerActor(provider.id, nihoUserId), {
      productId: query.experience,
      offerId: query.offer,
      localDate: query.date,
      localStartTime: query.start,
    });
    return { status: "live", session: siteSessionView(stored, query), now };
  } catch (error) {
    if (error instanceof StoreAccessDeniedError) return { status: "closed" };
    // An address the store cannot read (an experience or offer that is no identifier) names no session here.
    if (error instanceof StoreValidationError) return { status: "live", session: null, now };
    return { status: "error" };
  }
}
