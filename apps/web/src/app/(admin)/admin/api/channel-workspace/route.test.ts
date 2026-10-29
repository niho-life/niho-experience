import { beforeEach, describe, expect, it, vi } from "vitest";
import { StoreConflictError } from "@niho-experience/experience-store";

const mocks = vi.hoisted(() => ({
  enabled: true,
  csrf: true,
  load: vi.fn(),
  providers: vi.fn(),
  snapshot: vi.fn(),
  saveResource: vi.fn(),
  saveInventory: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/admin/server", () => ({ adminMutationAllowed: () => mocks.csrf, loadAdminHttpSession: mocks.load }));
vi.mock("@/lib/experience/channel-runtime", async () => {
  const actual = await vi.importActual<typeof import("@/lib/experience/channel-runtime")>("@/lib/experience/channel-runtime");
  return { ...actual, channelManagerEnabled: () => mocks.enabled };
});
vi.mock("@/lib/experience/store-server", () => ({ experienceStore: () => ({
  listInventoryAdminProviders: mocks.providers,
  getInventoryAdminSnapshot: mocks.snapshot,
  saveInventoryResourceAsAdmin: mocks.saveResource,
  saveProductInventorySettingAsAdmin: mocks.saveInventory,
}) }));

import { GET, POST } from "./route";

const COMMAND = "00000000-0000-4000-8000-000000000235";
const post = (body: unknown, headers: Record<string, string> = {}) => new Request("https://experience.example/admin/api/channel-workspace", {
  method: "POST",
  headers: { origin: "https://experience.example", "sec-fetch-site": "same-origin", "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.enabled = true;
  mocks.csrf = true;
  mocks.load.mockResolvedValue({ status: "ok", verified: { actor: { id: "verified-admin" } } });
  mocks.providers.mockResolvedValue([{ id: "provider-a", displayName: "Synthetic provider" }]);
  mocks.snapshot.mockResolvedValue({
    providerId: "provider-a",
    products: [{ id: "tea", publicTitle: "Synthetic tea", sellerDisplayName: "Synthetic provider", status: "PUBLISHED", stripeConnectAccountRef: "must-not-leak" }],
    resources: [{ providerId: "provider-a", id: "room", kind: "VENUE", displayName: "Synthetic room", active: true, version: 1, createdAtUtc: "2099-01-01T00:00:00.000Z", updatedAtUtc: "2099-01-01T00:00:00.000Z", privateProfileRef: "must-not-leak" }],
    customerEmail: "must-not-leak",
  });
  mocks.saveResource.mockResolvedValue({ aggregateId: "room", version: 1, repeated: false });
  mocks.saveInventory.mockResolvedValue({ aggregateId: "tea", version: 1, repeated: false });
});

describe("Admin channel workspace BFF", () => {
  it("checks the dedicated flag and fresh Admin session before reads", async () => {
    mocks.enabled = false;
    expect((await GET(new Request("https://experience.example/admin/api/channel-workspace?providerId=provider-a"))).status).toBe(404);
    expect(mocks.load).not.toHaveBeenCalled();
    mocks.enabled = true;
    mocks.load.mockResolvedValue({ status: "signed-out" });
    expect((await GET(new Request("https://experience.example/admin/api/channel-workspace?providerId=provider-a"))).status).toBe(401);
    expect(mocks.snapshot).not.toHaveBeenCalled();
  });

  it("returns only selected catalog and inventory fields", async () => {
    const response = await GET(new Request("https://experience.example/admin/api/channel-workspace?providerId=provider-a"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const json = await response.json();
    expect(json.selected.products[0]).toEqual({ id: "tea", publicTitle: "Synthetic tea", sellerDisplayName: "Synthetic provider", status: "PUBLISHED" });
    expect(JSON.stringify(json)).not.toContain("must-not-leak");
    expect(mocks.snapshot).toHaveBeenCalledWith({ nihoUserId: "verified-admin" }, "provider-a");
  });

  it("requires same-origin, bounded exact JSON, UUID v4, and positive versions", async () => {
    mocks.csrf = false;
    expect((await POST(post({}))).status).toBe(403);
    mocks.csrf = true;
    const base = { action: "saveResource", providerId: "provider-a", commandId: COMMAND, expectedVersion: null,
      resource: { id: "room", kind: "VENUE", displayName: "Synthetic room", active: false } };
    expect((await POST(post({ ...base, extra: true }))).status).toBe(400);
    expect((await POST(post({ ...base, commandId: "not-a-uuid" }))).status).toBe(400);
    expect((await POST(post({ ...base, expectedVersion: 0 }))).status).toBe(400);
    expect((await POST(post({ ...base, padding: "x".repeat(17 * 1024) }))).status).toBe(413);
    expect(mocks.saveResource).not.toHaveBeenCalled();
  });

  it("passes the immutable provider target and maps stale versions to 409", async () => {
    mocks.saveInventory.mockRejectedValueOnce(new StoreConflictError("stale"));
    const response = await POST(post({
      action: "saveProductInventory", providerId: "provider-b", productId: "foreign-product", commandId: COMMAND, expectedVersion: 3,
      inventory: { bookingMode: "PRIVATE_GROUP", resources: [{ resourceId: "foreign-room", prepareMinutes: 10, cleanupMinutes: 15 }] },
    }));
    expect(response.status).toBe(409);
    expect(mocks.saveInventory).toHaveBeenCalledWith(
      { nihoUserId: "verified-admin" }, "provider-b", "foreign-product",
      { bookingMode: "PRIVATE_GROUP", resources: [{ resourceId: "foreign-room", prepareMinutes: 10, cleanupMinutes: 15 }] }, 3, COMMAND,
    );
  });
});
