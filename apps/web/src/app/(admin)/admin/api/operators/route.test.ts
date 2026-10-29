import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ csrf: true, load: vi.fn(), snapshot: vi.fn(), create: vi.fn(), revokeInvitation: vi.fn(), revokeGrant: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: { hostConsoleEnabled: true, siteUrl: "https://experience.example" } }));
vi.mock("@/lib/admin/server", async () => {
  const { NextResponse } = await import("next/server");
  return { isAdminHttp: () => true, adminMutationAllowed: () => mocks.csrf, loadAdminHttpSession: mocks.load,
    adminJson: (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "cache-control": "private, no-store" } }) };
});
vi.mock("@/lib/experience/store-server", () => ({ productOperatorRepository: () => ({ adminSnapshot: mocks.snapshot, createInvitation: mocks.create, revokeInvitation: mocks.revokeInvitation, revokeGrant: mocks.revokeGrant }) }));

import { GET, POST } from "./route";

const ID = "00000000-0000-4000-8000-000000000196";
const COMMAND = "00000000-0000-4000-8000-000000000221";
const request = (body: unknown) => new Request("https://experience.example/admin/api/operators", { method: "POST", headers: { origin: "https://experience.example", "sec-fetch-site": "same-origin", "content-type": "application/json" }, body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks(); mocks.csrf = true; mocks.load.mockResolvedValue({ status: "ok", verified: { actor: { id: "admin-a" } } });
  mocks.snapshot.mockResolvedValue({ products: [], invitations: [], grants: [] });
  mocks.create.mockResolvedValue({ invitation: { id: ID }, token: "a".repeat(43), repeated: false });
});

describe("Admin product operator BFF", () => {
  it("re-verifies Admin for reads and bounds query keys", async () => {
    expect((await GET(new Request("https://experience.example/admin/api/operators?q=tea"))).status).toBe(200);
    expect(mocks.snapshot).toHaveBeenCalledWith("tea");
    expect((await GET(new Request("https://experience.example/admin/api/operators?providerId=all"))).status).toBe(400);
  });

  it("requires same-origin and returns the raw token only in the one-time URL fragment", async () => {
    mocks.csrf = false;
    expect((await POST(request({ action: "createInvitation", commandId: COMMAND, providerId: "provider-a", productId: "tea", assignmentLabel: "Teacher" }))).status).toBe(403);
    mocks.csrf = true;
    const response = await POST(request({ action: "createInvitation", commandId: COMMAND, providerId: "provider-a", productId: "tea", assignmentLabel: "Teacher" }));
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.link).toBe(`https://experience.example/host/invitations/${ID}#${"a".repeat(43)}`);
    expect(mocks.create).toHaveBeenCalledWith({ nihoUserId: "admin-a" }, expect.objectContaining({ providerId: "provider-a", productId: "tea" }), COMMAND);
  });

  it("does not recreate or reveal the token for a repeated create command", async () => {
    mocks.create.mockResolvedValue({ invitation: { id: ID }, repeated: true });
    const response = await POST(request({ action: "createInvitation", commandId: COMMAND, providerId: "provider-a", productId: "tea", assignmentLabel: "Teacher" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ invitation: { id: ID }, repeated: true });
  });
});
