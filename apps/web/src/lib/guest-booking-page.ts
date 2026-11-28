/*
 * The browser's side of 予約者の予約ページ (#285 slice 6, docs/guest-booking.md). The emails link to
 * `/bookings/open#g=<grant>`: the grant stays in the fragment, which browsers never send to a server or in a
 * Referer. The page reads it, takes it out of the address bar and posts it to this site only, which answers
 * with an HttpOnly cookie for that one booking. Nothing here reaches analytics, a URL or storage.
 */

const GRANT = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What "Find your booking" takes: as much as an address may hold. */
export const FIND_BOOKING_EMAIL_MAX_LENGTH = 254;

/** `#g=<grant>` from the address; null for anything else. */
export function grantFromFragment(hash: string): string | null {
  const grant = new URLSearchParams(hash.replace(/^#/, "")).get("g");
  return grant !== null && GRANT.test(grant) ? grant : null;
}

/** The booking page's path, for a public booking ID only. */
export function bookingPagePath(publicBookingId: string): string | null {
  return UUID.test(publicBookingId) ? `/bookings/${publicBookingId.toLowerCase()}` : null;
}

export type OpenBookingResult = { kind: "open"; path: string } | { kind: "closed" } | { kind: "failed" };
export type BookingLinkRequestResult = { kind: "sent" } | { kind: "invalid" } | { kind: "failed" };

type Fetch = (input: string, init: RequestInit) => Promise<Response>;
const browserFetch: Fetch = (input, init) => fetch(input, init);

/**
 * Same-origin POSTs only; `same-origin` so the request carries this site's Origin (the site's policy is no-referrer).
 * `withCookies` lets the answer set or clear the booking's cookie; the link request needs none.
 */
async function post(fetchImpl: Fetch, path: string, body: unknown, withCookies: boolean): Promise<Response | null> {
  try {
    return await fetchImpl(path, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      credentials: withCookies ? "same-origin" : "omit",
      redirect: "error",
      referrerPolicy: "same-origin",
    });
  } catch {
    return null;
  }
}

/** Opens the booking from the email's grant: the answer sets its cookie. Unknown, used and expired grants all read as closed. */
export async function openBookingFromGrant(grant: string, fetchImpl: Fetch = browserFetch): Promise<OpenBookingResult> {
  const response = await post(fetchImpl, "/api/public/bookings/session", { grant }, true);
  if (!response) return { kind: "failed" };
  if (response.status === 404) return { kind: "closed" };
  if (response.status !== 200) return { kind: "failed" };
  const body: unknown = await response.json().catch(() => null);
  const id = typeof body === "object" && body !== null ? (body as Record<string, unknown>).publicBookingId : undefined;
  const path = typeof id === "string" ? bookingPagePath(id) : null;
  return path ? { kind: "open", path } : { kind: "failed" };
}

/** "Find your booking": the same answer whether or not the address has a booking. */
export async function requestBookingLinkEmail(email: string, fetchImpl: Fetch = browserFetch): Promise<BookingLinkRequestResult> {
  const response = await post(fetchImpl, "/api/public/bookings/link", { email }, false);
  if (!response) return { kind: "failed" };
  if (response.status === 202) return { kind: "sent" };
  if (response.status === 422) return { kind: "invalid" };
  return { kind: "failed" };
}

/** Signs out of the booking on this device: its session ends and its cookie goes. */
export async function signOutOfBooking(publicBookingId: string, fetchImpl: Fetch = browserFetch): Promise<boolean> {
  const response = await post(fetchImpl, "/api/public/bookings/sign-out", { publicBookingId }, true);
  return response?.status === 204;
}

export type BookingCancelChoice = "FULL_REFUND" | "REQUEST";
export type BookingCancelOutcome = "CANCELLED" | "REQUESTED" | "CHANGED" | "NOT_CANCELLABLE";
export type BookingCancelResult =
  | { kind: "done"; outcome: BookingCancelOutcome }
  /** The session no longer opens this booking: the page shows its neutral state again. */
  | { kind: "closed" }
  /** The same command was refused (its input changed): the page starts over. */
  | { kind: "conflict" }
  /** No answer, or a server failure: whether it went through is unknown; sending the same command again is safe. */
  | { kind: "failed" };

const OUTCOMES: ReadonlySet<string> = new Set(["CANCELLED", "REQUESTED", "CHANGED", "NOT_CANCELLABLE"]);

/**
 * 取消 (#285 slice 7): "Cancel and get a full refund" or "Ask to cancel". `commandId` is the page's UUID for this
 * attempt, sent again as it is after a lost answer (the same command never cancels or refunds twice).
 * `shownDeadlineUtc` is the free cancellation deadline the page showed: the server refuses when it no longer holds.
 */
export async function cancelBooking(
  input: { publicBookingId: string; commandId: string; choice: BookingCancelChoice; shownDeadlineUtc: string | null },
  fetchImpl: Fetch = browserFetch,
): Promise<BookingCancelResult> {
  const response = await post(fetchImpl, "/api/public/bookings/cancel", input, true);
  if (!response) return { kind: "failed" };
  if (response.status === 404) return { kind: "closed" };
  if (response.status === 409) return { kind: "conflict" };
  if (response.status !== 200) return { kind: "failed" };
  const body: unknown = await response.json().catch(() => null);
  const outcome = typeof body === "object" && body !== null ? (body as Record<string, unknown>).outcome : undefined;
  return typeof outcome === "string" && OUTCOMES.has(outcome) ? { kind: "done", outcome: outcome as BookingCancelOutcome } : { kind: "failed" };
}

/** One date the booking may move to (予約の日時変更, #720), as the server offers it. */
export interface BookingChangeOptionView {
  date: string;
  startAtUtc: string;
  endAtUtc: string;
  seatsLeft: number;
  newDeadlineUtc: string;
}

export type BookingChangeOptionsResult =
  | { kind: "options"; fromStartUtc: string; changesUsed: number; maxChanges: number; options: BookingChangeOptionView[] }
  /** The booking can no longer be moved here: the page points to the messages with the host. */
  | { kind: "notChangeable" }
  /** The session no longer opens this booking: the page shows its neutral state again. */
  | { kind: "closed" }
  | { kind: "failed" };

const CHANGE_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CHANGE_DATE = /^\d{4}-\d{2}-\d{2}$/;

function changeOption(value: unknown): BookingChangeOptionView | null {
  if (typeof value !== "object" || value === null) return null;
  const item = value as Record<string, unknown>;
  const { date, startAtUtc, endAtUtc, seatsLeft, newDeadlineUtc } = item;
  if (typeof date !== "string" || !CHANGE_DATE.test(date)) return null;
  if (typeof startAtUtc !== "string" || !CHANGE_INSTANT.test(startAtUtc) || typeof endAtUtc !== "string" || !CHANGE_INSTANT.test(endAtUtc)) return null;
  if (typeof newDeadlineUtc !== "string" || !CHANGE_INSTANT.test(newDeadlineUtc)) return null;
  if (typeof seatsLeft !== "number" || !Number.isInteger(seatsLeft) || seatsLeft < 0) return null;
  return { date, startAtUtc, endAtUtc, seatsLeft, newDeadlineUtc };
}

/** 予約の日時変更 (#720): the dates the booking may move to now. */
export async function loadBookingChangeOptions(publicBookingId: string, fetchImpl: Fetch = browserFetch): Promise<BookingChangeOptionsResult> {
  const response = await post(fetchImpl, "/api/public/bookings/change/options", { publicBookingId }, true);
  if (!response) return { kind: "failed" };
  if (response.status === 404) return { kind: "closed" };
  if (response.status !== 200) return { kind: "failed" };
  const body: unknown = await response.json().catch(() => null);
  if (typeof body !== "object" || body === null) return { kind: "failed" };
  const value = body as Record<string, unknown>;
  if (value.changeable === false) return { kind: "notChangeable" };
  const { fromStartUtc, changesUsed, maxChanges } = value;
  if (value.changeable !== true || typeof fromStartUtc !== "string" || !CHANGE_INSTANT.test(fromStartUtc)
    || !Number.isInteger(changesUsed) || !Number.isInteger(maxChanges) || !Array.isArray(value.options)) return { kind: "failed" };
  const options = value.options.map(changeOption);
  if (options.some((option) => option === null)) return { kind: "failed" };
  return { kind: "options", fromStartUtc, changesUsed: changesUsed as number, maxChanges: maxChanges as number, options: options as BookingChangeOptionView[] };
}

export type BookingChangeOutcome = "OK" | "CHANGED" | "FULL" | "NOT_CHANGEABLE";
export type BookingChangeResult =
  | { kind: "done"; outcome: BookingChangeOutcome }
  | { kind: "closed" }
  /** The same command was refused (its input changed): the page starts over. */
  | { kind: "conflict" }
  /** No answer, or a server failure: whether it went through is unknown; sending the same command again is safe. */
  | { kind: "failed" };

const CHANGE_OUTCOMES: ReadonlySet<string> = new Set(["OK", "CHANGED", "FULL", "NOT_CHANGEABLE"]);

/**
 * 予約の日時変更 (#720): "Change date". `commandId` is the page's UUID for this attempt, sent again as it is after a lost
 * answer (the same command never moves twice). The `shown*` values are what the page showed: the server refuses when they
 * no longer hold.
 */
export async function changeBookingDate(
  input: { publicBookingId: string; commandId: string; toDate: string; shownFromStartUtc: string; shownToStartUtc: string; shownNewDeadlineUtc: string },
  fetchImpl: Fetch = browserFetch,
): Promise<BookingChangeResult> {
  const response = await post(fetchImpl, "/api/public/bookings/change", input, true);
  if (!response) return { kind: "failed" };
  if (response.status === 404) return { kind: "closed" };
  if (response.status === 409) return { kind: "conflict" };
  if (response.status !== 200) return { kind: "failed" };
  const body: unknown = await response.json().catch(() => null);
  const outcome = typeof body === "object" && body !== null ? (body as Record<string, unknown>).outcome : undefined;
  return typeof outcome === "string" && CHANGE_OUTCOMES.has(outcome) ? { kind: "done", outcome: outcome as BookingChangeOutcome } : { kind: "failed" };
}

/** What the guest may write to the host in one message (the store's GUEST_QUESTION_LIMITS.guestMessageMaxLength). */
export const BOOKING_MESSAGE_MAX_LENGTH = 1000;

export type BookingMessageResult =
  | { kind: "sent" }
  /** The booking takes no more messages (cancelled, or 30 days after the experience): the history stays. */
  | { kind: "closed" }
  /** 10 messages an hour: try again after `retryAfterSeconds`. */
  | { kind: "limited"; retryAfterSeconds: number }
  /** An empty or too long message. */
  | { kind: "invalid" }
  /** The key was used with other words: the page starts the message again with a new key. */
  | { kind: "conflict" }
  /** The session no longer opens this booking: the page shows its neutral state again. */
  | { kind: "signedOut" }
  /** No answer, or a server failure: whether it went through is unknown; sending the same words with the same key is safe. */
  | { kind: "failed" };

/**
 * 予約ごとのメッセージ (#285 slice 6b): the guest's message to the host about this booking. `clientRequestKey` is the
 * page's key for these words, sent again as it is after a lost answer (the same key never sends twice).
 */
export async function sendBookingMessage(
  input: { publicBookingId: string; clientRequestKey: string; message: string },
  fetchImpl: Fetch = browserFetch,
): Promise<BookingMessageResult> {
  const response = await post(fetchImpl, "/api/public/bookings/messages", input, true);
  if (!response) return { kind: "failed" };
  if (response.status === 200) return { kind: "sent" };
  if (response.status === 404) return { kind: "signedOut" };
  if (response.status === 422) return { kind: "invalid" };
  if (response.status === 429) {
    const seconds = Number(response.headers.get("retry-after"));
    return { kind: "limited", retryAfterSeconds: Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : 3600 };
  }
  if (response.status === 409) {
    const body: unknown = await response.json().catch(() => null);
    const error = typeof body === "object" && body !== null ? (body as Record<string, unknown>).error : undefined;
    return error === "CLOSED" ? { kind: "closed" } : { kind: "conflict" };
  }
  return { kind: "failed" };
}
