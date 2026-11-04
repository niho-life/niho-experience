import { beforeEach, describe, expect, it, vi } from "vitest";
import { StoreNotFoundError, StoreValidationError } from "@niho-experience/experience-store";

const mocks = vi.hoisted(() => ({ csrf: true, enabled: true, load: vi.fn(), repo: { listNotifications: vi.fn(), markNotificationRead: vi.fn() } }));
vi.mock("@/lib/config", () => ({ get config() { return { guestBookingEnabled: mocks.enabled }; } }));
vi.mock("@/lib/admin/server", async () => {
  const { NextResponse } = await import("next/server");
  return {
    isAdminHttp: () => true,
    adminMutationAllowed: () => mocks.csrf,
    loadAdminHttpSession: mocks.load,
    adminJson: (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "cache-control": "private, no-store" } }),
  };
});
vi.mock("@/lib/experience/store-server", () => ({ experienceSupportRepository: () => mocks.repo }));

import { GET, POST } from "./route";

const BASE = "https://experience.example/admin/api/site-bookings/notifications";
const ID = "00000000-0000-4000-8000-000000000221";
const post = (body: unknown) => new Request(BASE, { method: "POST", headers: { origin: "https://experience.example", "sec-fetch-site": "same-origin", "content-type": "application/json" }, body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.csrf = true;
  mocks.enabled = true;
  mocks.load.mockResolvedValue({ status: "ok", verified: { actor: { id: "admin-a" } } });
  mocks.repo = { listNotifications: vi.fn(async () => []), markNotificationRead: vi.fn(async () => undefined) };
});

describe("Experience Admin notifications API", () => {
  it("reads the actor's read state and never caches the result", async () => {
    const response = await GET(new Request(`${BASE}?unreadOnly=true`));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.repo.listNotifications).toHaveBeenCalledWith({ nihoUserId: "admin-a" }, { limit: 50, unreadOnly: true });
    expect((await GET(new Request(`${BASE}?unreadOnly=yes`))).status).toBe(400);
    expect((await GET(new Request(`${BASE}?providerId=all`))).status).toBe(400);
  });

  it("marks one notification read idempotently for the current Admin only", async () => {
    expect((await POST(post({ notificationId: ID }))).status).toBe(200);
    expect(mocks.repo.markNotificationRead).toHaveBeenCalledWith({ nihoUserId: "admin-a" }, ID);
    mocks.load.mockResolvedValueOnce({ status: "rejected" });
    expect((await POST(post({ notificationId: ID }))).status).toBe(401);
    mocks.repo.markNotificationRead.mockRejectedValueOnce(new StoreNotFoundError("notification"));
    expect((await POST(post({ notificationId: ID }))).status).toBe(404);
    mocks.repo.markNotificationRead.mockRejectedValueOnce(new StoreValidationError("id"));
    expect((await POST(post({ notificationId: ID }))).status).toBe(400);
  });

  it("checks the same-origin mutation guard and exact request shape", async () => {
    mocks.csrf = false;
    expect((await POST(post({ notificationId: ID }))).status).toBe(403);
    mocks.csrf = true;
    expect((await POST(post({ notificationId: ID, extra: true }))).status).toBe(400);
    expect((await POST(post({ notificationId: "bad" }))).status).toBe(400);
  });
});
