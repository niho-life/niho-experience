import { describe, expect, it, vi } from "vitest";
import { bookingPagePath, grantFromFragment, openBookingFromGrant, requestBookingLinkEmail, signOutOfBooking } from "./guest-booking-page";

/** The browser's side of the guest's booking page (#285 slice 6): fragment handling and same-origin POSTs. */
const GRANT = "sampleGrantAbcdefghijklmnopqrstuvwxyz012345";
const BOOKING = "0f8fad5b-d9cb-469f-a165-708677289501";

const answer = (status: number, body?: unknown) => async () => new Response(body === undefined ? null : JSON.stringify(body), { status });

describe("grantFromFragment", () => {
  it("reads #g=<grant> only, in its exact shape", () => {
    expect(grantFromFragment(`#g=${GRANT}`)).toBe(GRANT);
    expect(grantFromFragment(`g=${GRANT}`)).toBe(GRANT);
    expect(grantFromFragment(`#x=1&g=${GRANT}`)).toBe(GRANT);
    for (const hash of ["", "#", `#t=${GRANT}`, "#g=short", `#g=${GRANT}x`, `#g=${GRANT.slice(0, -1)}+`]) expect(grantFromFragment(hash)).toBeNull();
  });

  it("names the booking page for a booking ID only", () => {
    expect(bookingPagePath(BOOKING.toUpperCase())).toBe(`/bookings/${BOOKING}`);
    for (const id of ["", "open", "../admin", `${BOOKING}/x`]) expect(bookingPagePath(id)).toBeNull();
  });
});

describe("the same-origin POSTs", () => {
  it("posts the grant in the body, lets the answer set the cookie, and goes to the booking it names", async () => {
    const fetchImpl = vi.fn(answer(200, { publicBookingId: BOOKING }));
    expect(await openBookingFromGrant(GRANT, fetchImpl)).toEqual({ kind: "open", path: `/bookings/${BOOKING}` });
    const [path, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/api/public/bookings/session");
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin", referrerPolicy: "same-origin", redirect: "error", cache: "no-store" });
    expect(JSON.parse(String(init.body))).toEqual({ grant: GRANT });
    expect(path).not.toContain(GRANT);
  });

  it("reads a 404 as a closed link and anything else unexpected as a failure", async () => {
    expect(await openBookingFromGrant(GRANT, answer(404))).toEqual({ kind: "closed" });
    expect(await openBookingFromGrant(GRANT, answer(503))).toEqual({ kind: "failed" });
    expect(await openBookingFromGrant(GRANT, answer(200, { publicBookingId: "../admin" }))).toEqual({ kind: "failed" });
    expect(await openBookingFromGrant(GRANT, async () => { throw new TypeError("offline"); })).toEqual({ kind: "failed" });
  });

  it("asks for a link without cookies and reads the uniform answer", async () => {
    const fetchImpl = vi.fn(answer(202, { accepted: true }));
    expect(await requestBookingLinkEmail("guest@example.com", fetchImpl)).toEqual({ kind: "sent" });
    const [path, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/api/public/bookings/link");
    expect(init).toMatchObject({ credentials: "omit", referrerPolicy: "same-origin" });
    expect(await requestBookingLinkEmail("x", answer(422))).toEqual({ kind: "invalid" });
    expect(await requestBookingLinkEmail("guest@example.com", answer(503))).toEqual({ kind: "failed" });
  });

  it("signs out with the booking's ID and the cookie", async () => {
    const fetchImpl = vi.fn(answer(204));
    expect(await signOutOfBooking(BOOKING, fetchImpl)).toBe(true);
    const [path, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/api/public/bookings/sign-out");
    expect(init).toMatchObject({ credentials: "same-origin", referrerPolicy: "same-origin" });
    expect(JSON.parse(String(init.body))).toEqual({ publicBookingId: BOOKING });
    expect(await signOutOfBooking(BOOKING, answer(503))).toBe(false);
  });
});
