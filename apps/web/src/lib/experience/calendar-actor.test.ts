import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ session: null as Record<string, unknown> | null, load: { status: "ok", providers: [] } as Record<string, unknown>, assignments: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/host/server", async () => {
  const { NextResponse } = await import("next/server");
  return { readHostSession: async () => mocks.session, loadHostProviders: async () => mocks.load,
    noStoreJson: (body: unknown, status = 200) => NextResponse.json(body, { status }) };
});
vi.mock("@/lib/experience/store-server", () => ({ productOperatorRepository: () => ({ listAssignments: mocks.assignments }) }));

import { calendarActor, resolveCalendarContext } from "./calendar-actor";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.session = { nihoUserId: "operator-a", idTokenExpiresAt: Date.now() + 3600_000 };
  mocks.load = { status: "ok", providers: [] };
  mocks.assignments.mockResolvedValue([{ providerId: "provider-a", productId: "tea", productTitle: "Tea", sellerDisplayName: "Synthetic seller", assignmentLabel: "Teacher", grantVersion: 1 }]);
});

describe("calendar actor", () => {
  it("allows an operator calendar when NIHO returns a verified empty provider list", async () => {
    const result = await calendarActor("provider-a");
    expect(result).toMatchObject({ actor: { providerId: "provider-a", nihoUserId: "operator-a" }, access: { kind: "OPERATOR" } });
    expect(await resolveCalendarContext({ providerId: "provider-a" })).toMatchObject({ choice: { kind: "OPERATOR", id: "provider-a", memberRole: null } });
  });

  it("fails closed when NIHO identity cannot be refreshed and never substitutes the grant for identity", async () => {
    mocks.load = { status: "error" };
    const result = await calendarActor("provider-a");
    expect("response" in result && result.response.status).toBe(503);
    expect(mocks.assignments).not.toHaveBeenCalled();
  });

  it("keeps a real NIHO provider as MEMBER and does not create a false operator choice", async () => {
    mocks.load = { status: "ok", providers: [{ id: "provider-a", displayName: "Member provider", memberRole: "OWNER" }] };
    const result = await calendarActor("provider-a");
    expect(result).toMatchObject({ access: { kind: "MEMBER", nihoRole: "OWNER" } });
    expect(mocks.assignments).not.toHaveBeenCalled();
  });
});
