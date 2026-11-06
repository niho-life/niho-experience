import { beforeEach, describe, expect, it, vi } from "vitest";
import { StoreConflictError, StoreValidationError } from "@niho-experience/experience-store";

/** サポートONの予約の一覧 (#121/#128): the Admin BFF against a stubbed store. Synthetic data. */
const mocks = vi.hoisted(() => ({
  config: { guestBookingEnabled: true },
  http: true,
  load: vi.fn(),
  store: { supportEnabledBookings: vi.fn() },
  available: true,
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ get config() { return mocks.config; } }));
vi.mock("@/lib/admin/server", async () => {
  const { NextResponse } = await import("next/server");
  return {
    isAdminHttp: () => mocks.http,
    loadAdminHttpSession: mocks.load,
    adminJson: (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "cache-control": "private, no-store" } }),
  };
});
vi.mock("@/lib/experience/store-server", () => ({ bookingCancellations: () => (mocks.available ? mocks.store : null) }));

import { GET } from "./route";

const URL = "https://experience.example/admin/api/site-bookings/bookings";
const BOOKING = "0f8fad5b-d9cb-469f-a165-708677289501";
const CURSOR = "7f1c2b9e-3a4d-4c5e-8f70-112233445566";
const ROW = {
  publicBookingId: BOOKING, providerId: "provider-sample", experienceTitle: "Synthetic walk", status: "CONFIRMED", localDate: "2026-12-01",
  localStartTime: "10:00", timeZone: "Asia/Tokyo", startUtc: "2026-12-01T01:00:00.000Z", guestName: "Sample Guest", totalAmount: 7500,
  currency: "JPY", cancellationPolicy: "FREE_UNTIL_48H", cancellationRefundBasisPoints: 10000, freeCancellationUntilUtc: null, supportEligible: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.config = { guestBookingEnabled: true };
  mocks.http = true;
  mocks.available = true;
  mocks.load.mockResolvedValue({ status: "ok", verified: { actor: { id: "admin-a" } } });
  mocks.store.supportEnabledBookings.mockResolvedValue({ bookings: [ROW], nextCursor: CURSOR });
});

describe("Admin support-ON bookings BFF", () => {
  it("is not there when guest booking or the Admin HTTP mode is off", async () => {
    mocks.config = { guestBookingEnabled: false };
    expect((await GET(new Request(URL))).status).toBe(404);
    mocks.config = { guestBookingEnabled: true };
    mocks.http = false;
    expect((await GET(new Request(URL))).status).toBe(404);
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it("asks for a current Admin", async () => {
    mocks.load.mockResolvedValueOnce({ status: "rejected" });
    expect((await GET(new Request(URL))).status).toBe(401);
    mocks.load.mockResolvedValueOnce({ status: "signed-out" });
    expect((await GET(new Request(URL))).status).toBe(401);
    mocks.load.mockResolvedValueOnce({ status: "error" });
    expect((await GET(new Request(URL))).status).toBe(503);
    expect(mocks.store.supportEnabledBookings).not.toHaveBeenCalled();
  });

  it("refuses unknown, repeated, empty, overlong or combined query keys before the session", async () => {
    for (const search of [
      "?providerId=all", `?cursor=${CURSOR}&cursor=${CURSOR}`, "?cursor=", `?cursor=${"a".repeat(65)}`,
      `?cursor=${CURSOR}&publicBookingId=${BOOKING}`, `?publicBookingId=${BOOKING}&limit=100`,
    ]) {
      expect((await GET(new Request(`${URL}${search}`))).status, search).toBe(400);
    }
    expect(mocks.load).not.toHaveBeenCalled();
    expect(mocks.store.supportEnabledBookings).not.toHaveBeenCalled();
  });

  it("reads the first page, the next page by cursor, or one booking, privately", async () => {
    const first = await GET(new Request(URL));
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("private, no-store");
    expect(await first.json()).toEqual({ bookings: [ROW], nextCursor: CURSOR });
    expect(mocks.store.supportEnabledBookings).toHaveBeenLastCalledWith({ cursor: null });
    await GET(new Request(`${URL}?cursor=${CURSOR}`));
    expect(mocks.store.supportEnabledBookings).toHaveBeenLastCalledWith({ cursor: CURSOR });
    await GET(new Request(`${URL}?publicBookingId=${BOOKING}`));
    expect(mocks.store.supportEnabledBookings).toHaveBeenLastCalledWith({ publicBookingId: BOOKING });
  });

  it("maps the store's refusals and keeps the query out of the log", async () => {
    mocks.store.supportEnabledBookings.mockRejectedValueOnce(new StoreValidationError("cursor"));
    expect((await GET(new Request(`${URL}?cursor=not-a-uuid`))).status).toBe(400);
    mocks.store.supportEnabledBookings.mockRejectedValueOnce(new StoreConflictError("x"));
    expect((await GET(new Request(URL))).status).toBe(409);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.store.supportEnabledBookings.mockRejectedValueOnce(new Error(`timeout ${BOOKING}`));
    const failed = await GET(new Request(`${URL}?publicBookingId=${BOOKING}`));
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ error: "unavailable" });
    expect(JSON.stringify(errors.mock.calls)).not.toContain(BOOKING);
    errors.mockRestore();
    mocks.available = false;
    expect((await GET(new Request(URL))).status).toBe(503);
  });
});
