import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ enabled: vi.fn(), mutationAllowed: vi.fn(), load: vi.fn(), list: vi.fn(), mark: vi.fn(), failure: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/admin/server", () => ({
  adminMutationAllowed: mocks.mutationAllowed,
  isAdminHttpRead: mocks.enabled,
  loadAdminReadClient: mocks.load,
  adminReadFailureJson: mocks.failure,
  adminJson: (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "private, no-store" } }),
}));

import { GET, POST } from "./route";

const postRequest = (body: unknown, contentType = "application/json") => new Request("https://experience.example/admin/api/notifications", { method: "POST", headers: { "content-type": contentType, origin: "https://experience.example", "sec-fetch-site": "same-origin" }, body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.enabled.mockReturnValue(true);
  mocks.mutationAllowed.mockReturnValue(true);
  mocks.list.mockResolvedValue({ ok: true, data: { notifications: [], unreadCount: 4, nextCursor: null } });
  mocks.mark.mockResolvedValue({ ok: true, data: { notifications: [{ id: "notice-1", readAt: "2026-10-23T01:00:00.000Z" }], unreadCount: 3 } });
  mocks.load.mockResolvedValue({ ok: true, client: { listNotifications: mocks.list, markNotificationsRead: mocks.mark } });
  mocks.failure.mockImplementation(() => Response.json({ error: "unavailable" }, { status: 503, headers: { "cache-control": "private, no-store" } }));
});

describe("Admin HTTP notification BFF", () => {
  it("validates cursor/filter query and returns the global unread count", async () => {
    const response = await GET(new Request("https://experience.example/admin/api/notifications?cursor=next-1&unread=true&limit=50"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ notifications: [], unreadCount: 4, nextCursor: null });
    expect(mocks.list).toHaveBeenCalledWith({ cursor: "next-1", unread: true, limit: 50 });
    expect((await GET(new Request("https://experience.example/admin/api/notifications?search=pii"))).status).toBe(400);
  });

  it("rejects duplicate query keys before loading the admin session", async () => {
    for (const query of ["cursor=a&cursor=b", "unread=true&unread=false", "limit=1&limit=2"]) {
      expect((await GET(new Request(`https://experience.example/admin/api/notifications?${query}`))).status).toBe(400);
    }
    expect(mocks.load).not.toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("requires same-origin and rejects malformed or oversized read batches", async () => {
    mocks.mutationAllowed.mockReturnValue(false);
    expect((await POST(postRequest({ notificationIds: ["notice-1"] }))).status).toBe(403);
    expect(mocks.load).not.toHaveBeenCalled();
    mocks.mutationAllowed.mockReturnValue(true);
    expect((await POST(postRequest({ notificationIds: ["notice-1"] }, "application/json-patch+json"))).status).toBe(400);
    expect((await POST(postRequest({ notificationIds: ["notice-1"], extra: true }))).status).toBe(400);
    expect((await POST(postRequest({ notificationIds: Array.from({ length: 65 }, (_, index) => `notice-${index}`) }))).status).toBe(400);
    expect(mocks.mark).not.toHaveBeenCalled();
  });

  it("updates personal read state only from a successful whole response", async () => {
    const response = await POST(postRequest({ notificationIds: ["notice-1"] }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ notifications: [{ id: "notice-1", readAt: "2026-10-23T01:00:00.000Z" }], unreadCount: 3 });
    expect(mocks.mark).toHaveBeenCalledWith({ notificationIds: ["notice-1"] });
  });

  it("keeps failures distinct from an empty notification result", async () => {
    mocks.list.mockResolvedValue({ ok: false, kind: "unexpected_response", status: 200 });
    const response = await GET(new Request("https://experience.example/admin/api/notifications"));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "unavailable" });
  });
});
