import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  preview: vi.fn(),
  mutationAllowed: vi.fn(),
  session: vi.fn(),
  list: vi.fn(),
  mark: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/admin/server", () => ({
  isAdminPreview: mocks.preview,
  adminMutationAllowed: mocks.mutationAllowed,
  readAdminSession: mocks.session,
  adminJson: (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "private, no-store" } }),
}));
vi.mock("@/admin/preview-store", () => ({
  adminPreviewNotifications: mocks.list,
  markAdminPreviewNotificationsRead: mocks.mark,
}));

import { GET, POST } from "./route";

const session = { id: "preview-session-route", actorId: "admin-preview", actorName: "Preview Admin", expiresAt: 100_000 };
const request = (body: unknown) => new Request("https://experience.example.test/admin/api/preview-notifications", {
  method: "POST",
  headers: { "content-type": "application/json", origin: "https://experience.example.test", "sec-fetch-site": "same-origin" },
  body: JSON.stringify(body),
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.preview.mockReturnValue(true);
  mocks.mutationAllowed.mockReturnValue(true);
  mocks.session.mockResolvedValue(session);
  mocks.list.mockReturnValue({ notifications: [], unreadCount: 0 });
  mocks.mark.mockReturnValue({ ok: true, notifications: [], unreadCount: 0 });
});

describe("Admin preview notification route", () => {
  it("hides both methods when the preview gate is off", async () => {
    mocks.preview.mockReturnValue(false);
    const get = await GET();
    const post = await POST(request({ notificationIds: ["notice-a"] }));
    expect([get.status, post.status]).toEqual([404, 404]);
    expect(get.headers.get("cache-control")).toBe("private, no-store");
    expect(post.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.session).not.toHaveBeenCalled();
  });

  it("requires a valid preview session for reads", async () => {
    mocks.session.mockResolvedValue(null);
    const response = await GET();
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("rejects cross-site and malformed writes before mutation", async () => {
    mocks.mutationAllowed.mockReturnValue(false);
    expect((await POST(request({ notificationIds: ["notice-a"] }))).status).toBe(403);
    expect(mocks.session).not.toHaveBeenCalled();
    expect(mocks.mark).not.toHaveBeenCalled();

    mocks.mutationAllowed.mockReturnValue(true);
    const malformed = await POST(request({ notificationIds: ["notice-a"], unexpected: true }));
    expect(malformed.status).toBe(400);
    expect(malformed.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.mark).not.toHaveBeenCalled();
  });

  it("returns store refusal without reporting a partial success", async () => {
    mocks.mark.mockReturnValue({ ok: false, status: 400, message: "unknown notification" });
    const response = await POST(request({ notificationIds: ["notice-unknown"] }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "notification_update_refused", message: "unknown notification" });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.mark).toHaveBeenCalledWith(session.id, session.expiresAt, ["notice-unknown"]);
  });
});
