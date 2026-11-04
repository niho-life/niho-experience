import { beforeEach, describe, expect, it, vi } from "vitest";
import { StoreAccessDeniedError, StoreConflictError } from "@niho-experience/experience-store";

const mocks = vi.hoisted(() => ({
  csrf: true,
  config: { guestBookingEnabled: true, siteUrl: "https://experience.example" },
  load: vi.fn(),
  store: { previewSupportOperation: vi.fn() } as { previewSupportOperation: ReturnType<typeof vi.fn> } | null,
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ get config() { return mocks.config; } }));
vi.mock("@/lib/admin/server", async () => {
  const { NextResponse } = await import("next/server");
  return {
    isAdminHttp: () => true,
    adminMutationAllowed: () => mocks.csrf,
    loadAdminHttpSession: mocks.load,
    adminJson: (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "cache-control": "private, no-store" } }),
  };
});
vi.mock("@/lib/experience/store-server", () => ({ bookingCancellations: () => mocks.store }));

import { POST } from "./route";

const URL = "https://experience.example/admin/api/site-bookings/preview";
const BOOKING = "0f8fad5b-d9cb-469f-a165-708677289501";
const ACTOR = { nihoUserId: "admin-a" };
const PREVIEW = {
  action: "CANCEL", expectedSnapshot: "a".repeat(64), publicBookingId: BOOKING, providerId: "provider-a",
  experienceTitle: "Synthetic walk", startUtc: "2026-11-10T01:00:00.000Z", bookingStatus: "CONFIRMED",
  bookingStatusAfter: "CANCELLED", refundAmount: 3000, currency: "JPY", cancellationRequestStatus: null,
};
const post = (body: unknown, contentType = "application/json") => new Request(URL, {
  method: "POST",
  headers: { origin: "https://experience.example", "sec-fetch-site": "same-origin", "content-type": contentType },
  body: JSON.stringify(body),
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.csrf = true;
  mocks.config = { guestBookingEnabled: true, siteUrl: "https://experience.example" };
  mocks.load.mockResolvedValue({ status: "ok", verified: { actor: { id: "admin-a" } } });
  mocks.store = { previewSupportOperation: vi.fn(async () => PREVIEW) };
});

describe("Admin site booking support preview", () => {
  it("returns the current Store snapshot without caching or performing the action", async () => {
    const response = await POST(post({ action: "CANCEL", publicBookingId: BOOKING, refund: { kind: "PARTIAL", amount: 3000 } }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual(PREVIEW);
    expect(mocks.store?.previewSupportOperation).toHaveBeenCalledWith(ACTOR, { action: "CANCEL", publicBookingId: BOOKING, refund: { kind: "PARTIAL", amount: 3000 } });
  });

  it("requires same-origin strict JSON with action-specific keys", async () => {
    mocks.csrf = false;
    expect((await POST(post({ action: "DECLINE_REQUEST", publicBookingId: BOOKING }))).status).toBe(403);
    mocks.csrf = true;
    expect((await POST(post({ action: "DECLINE_REQUEST", publicBookingId: BOOKING }, "text/plain"))).status).toBe(400);
    expect((await POST(post({ action: "DECLINE_REQUEST", publicBookingId: BOOKING, message: "must not be previewed" }))).status).toBe(400);
    expect((await POST(post({ action: "CANCEL", publicBookingId: BOOKING, refund: { kind: "FULL", amount: 1 } }))).status).toBe(400);
    expect((await POST(new Request(`${URL}?x=1`, { method: "POST", headers: { origin: "https://experience.example", "sec-fetch-site": "same-origin", "content-type": "application/json" }, body: JSON.stringify({ action: "DECLINE_REQUEST", publicBookingId: BOOKING }) }))).status).toBe(400);
    expect(mocks.store?.previewSupportOperation).not.toHaveBeenCalled();
  });

  it("keeps auth, flag, Store conflict/consent and unavailable failures closed", async () => {
    mocks.load.mockResolvedValueOnce({ status: "rejected" });
    expect((await POST(post({ action: "DECLINE_REQUEST", publicBookingId: BOOKING }))).status).toBe(401);
    mocks.load.mockResolvedValueOnce({ status: "error" });
    expect((await POST(post({ action: "DECLINE_REQUEST", publicBookingId: BOOKING }))).status).toBe(503);
    mocks.store!.previewSupportOperation.mockRejectedValueOnce(new StoreConflictError("changed"));
    expect((await POST(post({ action: "DECLINE_REQUEST", publicBookingId: BOOKING }))).status).toBe(409);
    mocks.store!.previewSupportOperation.mockRejectedValueOnce(new StoreAccessDeniedError());
    expect((await POST(post({ action: "DECLINE_REQUEST", publicBookingId: BOOKING }))).status).toBe(403);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.store!.previewSupportOperation.mockRejectedValueOnce(new Error("timeout"));
    expect((await POST(post({ action: "DECLINE_REQUEST", publicBookingId: BOOKING }))).status).toBe(503);
    errors.mockRestore();
    mocks.store = null;
    expect((await POST(post({ action: "DECLINE_REQUEST", publicBookingId: BOOKING }))).status).toBe(503);
    mocks.config = { ...mocks.config, guestBookingEnabled: false };
    expect((await POST(post({ action: "DECLINE_REQUEST", publicBookingId: BOOKING }))).status).toBe(404);
  });
});
