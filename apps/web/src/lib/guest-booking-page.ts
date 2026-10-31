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
