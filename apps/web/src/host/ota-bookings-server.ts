import "server-only";
import { StoreAccessDeniedError, StoreNotFoundError, StoreValidationError, type HostActor, type HostOtaBooking, type HostOtaBookings } from "@niho-experience/experience-store";
import { config } from "@/lib/config";
import { hostOtaBookings, productOperatorRepository } from "@/lib/experience/store-server";
import type { HostProvider } from "@/lib/host/providers";
import { isHostMock, loadHostProviders, readHostSession } from "@/lib/host/server";
import { idTokenUsable, type HostMockScenario } from "@/lib/host/session";
import { addDays, todayInJapan } from "./format";
import { actionTime, type BookingExperience, type SessionQuery } from "./bookings";
import { HOST_INVALID_INPUT_TEXT, HOST_SESSION_ENDED_TEXT } from "./errors";
import type { HomeTodo } from "./home";
import { MOCK_NOW, MOCK_TODAY } from "./mock/bookings";
import { MOCK_OTA_BOOKINGS } from "./mock/ota-bookings";
import { otaBooking, otaBookingExperiences, otaHomeTodos } from "./ota-bookings";
import type { HostActionResult } from "./payout";
import { SITE_ATTENDANCE_FAILED_TEXT, SITE_ATTENDANCE_NOT_CONFIRMED_TEXT, SITE_ATTENDANCE_NOT_STARTED_TEXT } from "./site-sessions";
import type { HostAttendance, HostBooking } from "./types";

/*
 * OTA の予約の画面 (#194 PR B, owner decision 2026-11-01): what 予約, ホーム and この回 read of the bookings made on
 * reservation sites (HostOtaBookings, the experience DB's external ledger). Who reads them: the provider's OWNER (NIHO says
 * so, and the store checks its own OWNER membership) for every product, a product operator (docs/product-operators.md) for
 * the products assigned to them only; the store decides which from the grants, never from the request. Closed while
 * EXPERIENCE_OTA_GUEST_DETAILS_ENABLED or the DB is not set. The preview reads synthetic ones with `?mock=ota-bookings`.
 */

/** 予約 reads this window of sessions: from a month back to three months ahead (the store's window is at most 120 days). */
const LIST_DAYS_BACK = 30;
const LIST_DAYS_AHEAD = 90;
const LIST_LIMIT = 200;

export type OtaReaderKind = "OWNER" | "OPERATOR";

/** Who reads a provider's OTA bookings, as the store will check it. */
export interface OtaReader {
  readonly kind: OtaReaderKind;
  readonly actor: HostActor;
}

/**
 * The reader for `providerId`: NIHO's OWNER, else a product operator with a grant there (the store narrows them to their
 * products). null for anyone else (an EDITOR or a COHOST without a grant reads none).
 */
export async function otaReaderFor(providerId: string, nihoUserId: string, provider: Pick<HostProvider, "memberRole"> | null): Promise<OtaReader | null> {
  if (provider?.memberRole === "OWNER") return { kind: "OWNER", actor: { providerId, nihoUserId, calendarRoleCeiling: "OWNER" } };
  const repository = productOperatorRepository();
  if (!repository) return null;
  const assignments = await repository.listAssignments(nihoUserId);
  if (!assignments.some((entry) => entry.providerId === providerId)) return null;
  return { kind: "OPERATOR", actor: { providerId, nihoUserId, calendarScope: "OPERATOR" } };
}

/** The start of a day in Japan, canonical UTC. */
const startOf = (day: string) => new Date(`${day}T00:00:00+09:00`).toISOString();

export type HostOtaBookingsLoad =
  | {
      status: "live";
      bookings: HostBooking[];
      experiences: BookingExperience[];
      /** `?ota=` (or `?booking=`) names none of the bookings this reader may read. */
      requestedMissing: boolean;
      reader: OtaReaderKind;
      /** The day the list counts from (YYYY-MM-DD in Japan; the preview's fixed day). */
      today: string;
      /** The preview's synthetic bookings (`?mock=ota-bookings`): read only. */
      preview?: true;
    }
  | { status: "closed" }
  | { status: "error" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function page(stored: readonly HostOtaBooking[], requested: string | null, reader: OtaReaderKind, today: string, preview = false): HostOtaBookingsLoad {
  const requestedMissing = requested !== null && UUID.test(requested) && !stored.some((booking) => booking.ref === requested.toLowerCase());
  return { status: "live", bookings: stored.map(otaBooking), experiences: otaBookingExperiences(stored), requestedMissing, reader, today, ...(preview ? { preview: true as const } : {}) };
}

/** Whether OTA bookings are shown in this deployment: the flag (http mode) or the preview's scenario (mock mode). */
export function otaBookingsShown(mockScenario?: HostMockScenario): boolean {
  return isHostMock() ? mockScenario === "ota-bookings" : config.otaGuestDetailsEnabled;
}

/**
 * 予約's OTA bookings for one provider: a month back to three months ahead, with the one `requested` names (`?ota=`, the
 * push's link) when it is outside that window. `provider` is NIHO's (null for a product operator without membership).
 */
export async function loadOtaBookings(
  providerId: string,
  nihoUserId: string,
  provider: Pick<HostProvider, "memberRole"> | null,
  requested: string | null,
  mockScenario?: HostMockScenario,
  store: () => Pick<HostOtaBookings, "listForHost" | "getForHost"> | null = hostOtaBookings,
): Promise<HostOtaBookingsLoad> {
  if (isHostMock()) return mockScenario === "ota-bookings" && provider?.memberRole === "OWNER" ? page(MOCK_OTA_BOOKINGS, requested, "OWNER", MOCK_TODAY, true) : { status: "closed" };
  const bookings = store();
  if (!bookings) return { status: "closed" };
  try {
    const reader = await otaReaderFor(providerId, nihoUserId, provider);
    if (!reader) return { status: "closed" };
    const today = todayInJapan(Date.now());
    const from = addDays(today, -LIST_DAYS_BACK);
    const stored = [...await bookings.listForHost(reader.actor, { fromUtc: startOf(from), toUtc: startOf(addDays(from, LIST_DAYS_BACK + LIST_DAYS_AHEAD)), limit: LIST_LIMIT })];
    if (requested && UUID.test(requested) && !stored.some((booking) => booking.ref === requested.toLowerCase())) {
      try {
        stored.push(await bookings.getForHost(reader.actor, requested));
      } catch (error) {
        if (!(error instanceof StoreNotFoundError || error instanceof StoreValidationError)) throw error;
      }
    }
    return page(stored, requested, reader.kind, today);
  } catch (error) {
    return error instanceof StoreAccessDeniedError ? { status: "closed" } : { status: "error" };
  }
}

export type HostOtaSessionLoad =
  | {
      status: "live";
      /** The session's OTA bookings, each with the guest's phone (この回 is where it is called), and its 出欠. */
      bookings: HostBooking[];
      /** 出欠 is kept for them (EXPERIENCE_HOST_ATTENDANCE_ENABLED, migration 0039). */
      attendance: boolean;
      reader: OtaReaderKind;
      /** YYYY-MM-DDTHH:MM in Japan (the preview's fixed moment): whether the session has started. */
      now: string;
    }
  | { status: "closed" }
  | { status: "error" };

/** One booking as この回 shows it: the guest's phone the site gave, as this site's bookings' (#103: この回 only, and the detail for OTA). */
function sessionBooking(booking: HostBooking): HostBooking {
  return { ...booking, phone: booking.ota?.phone ?? null };
}

/**
 * この回's OTA bookings: those of the product whose session is the one `?date=&start=&experience=&offer=` names (the
 * session's own day and time in Japan), with their 出欠 where it is kept.
 */
export async function loadOtaSession(
  providerId: string,
  nihoUserId: string,
  provider: Pick<HostProvider, "memberRole"> | null,
  query: SessionQuery,
  mockScenario?: HostMockScenario,
  store: () => Pick<HostOtaBookings, "listForHost" | "attendanceForHost"> | null = hostOtaBookings,
): Promise<HostOtaSessionLoad> {
  const inSession = (booking: HostBooking) => booking.date === query.date && booking.start === query.start && booking.experienceId === query.experience && booking.offerId === query.offer;
  if (isHostMock()) {
    if (mockScenario !== "ota-bookings" || provider?.memberRole !== "OWNER") return { status: "closed" };
    return { status: "live", bookings: MOCK_OTA_BOOKINGS.map(otaBooking).filter(inSession).map(sessionBooking), attendance: false, reader: "OWNER", now: MOCK_NOW };
  }
  const bookings = store();
  if (!bookings || !query.offer) return { status: "closed" };
  try {
    const reader = await otaReaderFor(providerId, nihoUserId, provider);
    if (!reader) return { status: "closed" };
    // The offer's sessions a day either side (the session's own time may differ from the one the site gave), narrowed in
    // the store before its limit. A session that still fills it is not shown in part: the screen says it cannot be read.
    const stored = await bookings.listForHost(reader.actor, {
      fromUtc: startOf(addDays(query.date, -1)), toUtc: startOf(addDays(query.date, 2)), productId: query.experience, offerId: query.offer, limit: LIST_LIMIT,
    });
    if (stored.length >= LIST_LIMIT) return { status: "error" };
    const shown = stored.map(otaBooking).filter(inSession).map(sessionBooking);
    const attendance = config.hostAttendanceEnabled;
    if (attendance && shown.length) {
      const marks = await bookings.attendanceForHost(reader.actor, shown.map((booking) => booking.id));
      for (const booking of shown) {
        const mark = marks.get(booking.id);
        booking.attendance = mark === "ATTENDED" ? "attended" : mark === "NO_SHOW" ? "no_show" : null;
      }
    }
    const clock = Date.now();
    return { status: "live", bookings: shown, attendance, reader: reader.kind, now: actionTime(todayInJapan(clock), clock) };
  } catch (error) {
    if (error instanceof StoreAccessDeniedError) return { status: "closed" };
    if (error instanceof StoreValidationError) return { status: "live", bookings: [], attendance: false, reader: "OWNER", now: actionTime(todayInJapan(Date.now()), Date.now()) };
    return { status: "error" };
  }
}

/** ホーム's 次にすること: the OTA bookings read in the last three days whose session is ahead. None while closed or unreadable. */
export async function loadOtaHomeTodos(
  providerId: string,
  nihoUserId: string,
  provider: Pick<HostProvider, "memberRole"> | null,
  mockScenario?: HostMockScenario,
  store: () => Pick<HostOtaBookings, "listForHost"> | null = hostOtaBookings,
): Promise<{ todos: HomeTodo[]; failed: boolean }> {
  if (isHostMock()) {
    return { todos: mockScenario === "ota-bookings" && provider?.memberRole === "OWNER" ? otaHomeTodos(MOCK_OTA_BOOKINGS, Date.parse(`${MOCK_TODAY}T12:00:00+09:00`)) : [], failed: false };
  }
  const bookings = store();
  if (!bookings) return { todos: [], failed: false };
  try {
    const reader = await otaReaderFor(providerId, nihoUserId, provider);
    if (!reader) return { todos: [], failed: false };
    const now = Date.now();
    const today = todayInJapan(now);
    const stored = await bookings.listForHost(reader.actor, { fromUtc: startOf(today), toUtc: startOf(addDays(today, 120)), limit: LIST_LIMIT });
    return { todos: otaHomeTodos(stored, now), failed: false };
  } catch (error) {
    return { todos: [], failed: !(error instanceof StoreAccessDeniedError) };
  }
}

const STORED: Record<HostAttendance, "ATTENDED" | "NO_SHOW"> = { attended: "ATTENDED", no_show: "NO_SHOW" };

/**
 * この回 › 来た / 来なかった for an OTA booking (#194 PR B): the product's OWNER or its operator, once the session has started
 * (the store decides by the database's clock). Answers the booking's mark as stored now.
 */
export async function recordOtaAttendanceAsHost(providerId: string, ref: string, value: HostAttendance): Promise<HostActionResult<{ attendance: HostAttendance | null }>> {
  const session = await readHostSession();
  if (!session || !idTokenUsable(session, Date.now())) return { ok: false, message: HOST_SESSION_ENDED_TEXT };
  const bookings = hostOtaBookings();
  if (!bookings || !config.hostAttendanceEnabled) return { ok: false, message: SITE_ATTENDANCE_FAILED_TEXT };
  const providers = await loadHostProviders();
  if (providers.status !== "ok") return { ok: false, message: providers.status === "error" ? SITE_ATTENDANCE_FAILED_TEXT : HOST_SESSION_ENDED_TEXT };
  try {
    const reader = await otaReaderFor(providerId, session.nihoUserId, providers.providers.find((entry) => entry.id === providerId) ?? null);
    if (!reader) return { ok: false, message: SITE_ATTENDANCE_FAILED_TEXT };
    const result = await bookings.recordAttendanceAsHost(reader.actor, ref, STORED[value]);
    if (result.outcome === "NOT_STARTED") return { ok: false, message: SITE_ATTENDANCE_NOT_STARTED_TEXT };
    if (result.outcome === "NOT_CONFIRMED") return { ok: false, message: SITE_ATTENDANCE_NOT_CONFIRMED_TEXT };
    return { ok: true, message: "", attendance: result.status === "ATTENDED" ? "attended" : result.status === "NO_SHOW" ? "no_show" : null };
  } catch (error) {
    if (error instanceof StoreValidationError) return { ok: false, message: HOST_INVALID_INPUT_TEXT };
    if (error instanceof StoreNotFoundError || error instanceof StoreAccessDeniedError) return { ok: false, message: SITE_ATTENDANCE_FAILED_TEXT };
    console.error("Experience OTA attendance failed", { error: error instanceof Error ? error.name : typeof error });
    return { ok: false, message: SITE_ATTENDANCE_FAILED_TEXT };
  }
}
