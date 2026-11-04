import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  config: { guestBookingEnabled: true, guestMailEnabled: true },
  access: { readBookingMeetingPhoto: vi.fn() },
  storage: { read: vi.fn() },
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ get config() { return state.config; } }));
vi.mock("@/lib/experience/store-server", () => ({ guestBookingAccess: () => state.access }));
vi.mock("@/lib/experience/public-media-storage", () => ({ experiencePublicMediaStorage: () => state.storage }));

import { GET } from "@/app/api/public/bookings/[publicBookingId]/meeting-photo/route";
import { bookingSessionCookieName } from "@/lib/experience/booking-access-http";

const BOOKING = "0f8fad5b-d9cb-469f-a165-708677289501";
const SESSION = "a".repeat(43);
const PHOTO = `/api/public/bookings/${BOOKING}/meeting-photo`;

function get(path = PHOTO, cookie = `${bookingSessionCookieName(BOOKING)}=${SESSION}`) {
  return GET(new Request(`https://experience.example${path}`, { headers: cookie ? { cookie } : {} }), {
    params: Promise.resolve({ publicBookingId: BOOKING }),
  });
}

beforeEach(() => {
  state.config = { guestBookingEnabled: true, guestMailEnabled: true };
  state.access.readBookingMeetingPhoto.mockReset().mockResolvedValue({ objectKey: "experience-products/synthetic.jpg", byteSize: 3 });
  state.storage.read.mockReset().mockResolvedValue(Buffer.from([0xff, 0xd8, 0xff]));
});

describe("GET /api/public/bookings/{id}/meeting-photo", () => {
  it("serves the rights-confirmed photo through the same booking's no-store session cookie", async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([0xff, 0xd8, 0xff]));
    expect(state.access.readBookingMeetingPhoto).toHaveBeenCalledExactlyOnceWith(SESSION, BOOKING);
    expect(state.storage.read).toHaveBeenCalledExactlyOnceWith("experience-products/synthetic.jpg");
  });

  it("does not read storage without this booking's session, after cancellation, or when the feature is closed", async () => {
    expect((await get(PHOTO, "" )).status).toBe(404);
    expect(state.access.readBookingMeetingPhoto).not.toHaveBeenCalled();
    state.access.readBookingMeetingPhoto.mockResolvedValueOnce(null);
    expect((await get()).status).toBe(404);
    expect(state.storage.read).not.toHaveBeenCalled();
    state.config.guestMailEnabled = false;
    expect((await get()).status).toBe(404);
    expect(state.storage.read).not.toHaveBeenCalled();
  });
});
