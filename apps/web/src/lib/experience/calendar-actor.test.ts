import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ session: null as Record<string, unknown> | null, load: { status: "ok", nihoUserId: "operator-a", providers: [] } as Record<string, unknown>, assignments: vi.fn(), config: { hostMailEnabled: false, otaGuestDetailsEnabled: false } }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ get config() { return mocks.config; } }));
vi.mock("@/lib/host/server", async () => {
  const { NextResponse } = await import("next/server");
  return { readHostSession: async () => mocks.session, loadHostProviders: async () => mocks.load,
    noStoreJson: (body: unknown, status = 200) => NextResponse.json(body, { status }) };
});
vi.mock("@/lib/experience/store-server", () => ({ productOperatorRepository: () => ({ listAssignments: mocks.assignments }) }));

import { calendarActor, resolveCalendarContext } from "./calendar-actor";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.session = { accessToken: "sealed-token", accessTokenExpiresAt: Date.now() + 3600_000 };
  mocks.load = { status: "ok", nihoUserId: "operator-a", providers: [{ id: "owned-provider", nihoUserId: "operator-a", displayName: "Owned provider", memberRole: "OWNER" }] };
  mocks.assignments.mockResolvedValue([{ providerId: "provider-a", productId: "tea", productTitle: "Tea", sellerDisplayName: "Synthetic seller", assignmentLabel: "Teacher", grantVersion: 1 }]);
});

describe("calendar actor", () => {
  it("uses one owned provider as the current identity for an operator grant", async () => {
    const result = await calendarActor("provider-a");
    expect(result).toMatchObject({ actor: { providerId: "provider-a", nihoUserId: "operator-a", calendarScope: "OPERATOR" }, access: { kind: "OPERATOR" } });
    expect(await resolveCalendarContext({ providerId: "provider-a" })).toMatchObject({ choice: { kind: "OPERATOR", id: "provider-a", memberRole: null } });
  });

  it("opens an editor product in its one exact OWNER workspace instead of the first unrelated choice", async () => {
    mocks.load = { status: "ok", nihoUserId: "operator-a", providers: [
      { id: "editor-first", nihoUserId: "operator-a", displayName: "A editor workspace", memberRole: "EDITOR" },
      { id: "owned-provider", nihoUserId: "operator-a", displayName: "Z owner workspace", memberRole: "OWNER" },
    ] };
    expect(await resolveCalendarContext({ experience: "product-synthetic" })).toMatchObject({
      choice: { kind: "MEMBER", id: "owned-provider", memberRole: "OWNER" },
      providerNotFound: false,
    });
  });

  it("does not guess a workspace when a product entry has no unique OWNER", async () => {
    mocks.load = { status: "ok", nihoUserId: "operator-a", providers: [
      { id: "owner-a", nihoUserId: "operator-a", displayName: "Owner A", memberRole: "OWNER" },
      { id: "owner-b", nihoUserId: "operator-a", displayName: "Owner B", memberRole: "OWNER" },
    ] };
    expect(await resolveCalendarContext({ experience: "product-synthetic" })).toMatchObject({ choice: null, providerNotFound: true });
  });

  it("uses the Host v1 identity when no seller membership is returned", async () => {
    mocks.load = { status: "ok", nihoUserId: "operator-a", providers: [] };
    expect(await calendarActor("provider-a")).toMatchObject({ actor: { nihoUserId: "operator-a", calendarScope: "OPERATOR" }, access: { kind: "OPERATOR" } });
    expect(await resolveCalendarContext({ providerId: "provider-a" })).toMatchObject({ choice: { kind: "OPERATOR", id: "provider-a" }, providerNotFound: false });
    expect(mocks.assignments).toHaveBeenCalledWith("operator-a");
  });

  it("gives an operator 設定 for their own email address while this site emails hosts (#194)", async () => {
    expect((await resolveCalendarContext({ providerId: "provider-a" }))?.choice).toMatchObject({ kind: "OPERATOR", screens: ["/host/calendar"] });
    mocks.config = { hostMailEnabled: true, otaGuestDetailsEnabled: false };
    try {
      expect((await resolveCalendarContext({ providerId: "provider-a" }))?.choice).toMatchObject({ kind: "OPERATOR", screens: ["/host/calendar", "/host/settings"] });
    } finally {
      mocks.config = { hostMailEnabled: false, otaGuestDetailsEnabled: false };
    }
  });

  it("gives an operator 予約 for the OTA bookings of their products while they are shown (#194 PR B)", async () => {
    mocks.config = { hostMailEnabled: true, otaGuestDetailsEnabled: true };
    try {
      expect((await resolveCalendarContext({ providerId: "provider-a" }))?.choice).toMatchObject({ kind: "OPERATOR", screens: ["/host/calendar", "/host/bookings", "/host/settings"] });
    } finally {
      mocks.config = { hostMailEnabled: false, otaGuestDetailsEnabled: false };
    }
  });

  it("fails closed when NIHO identity cannot be refreshed and never substitutes the grant for identity", async () => {
    mocks.load = { status: "error" };
    const result = await calendarActor("provider-a");
    expect("response" in result && result.response.status).toBe(503);
    expect(mocks.assignments).not.toHaveBeenCalled();
  });

  it("keeps a real NIHO provider as MEMBER and does not create a false operator choice", async () => {
    mocks.load = { status: "ok", nihoUserId: "operator-a", providers: [{ id: "provider-a", nihoUserId: "operator-a", displayName: "Member provider", memberRole: "OWNER" }] };
    const result = await calendarActor("provider-a");
    expect(result).toMatchObject({ access: { kind: "MEMBER", nihoRole: "OWNER" } });
    expect(mocks.assignments).not.toHaveBeenCalled();
  });

  it("uses the current NIHO membership for a provider before considering an operator grant", async () => {
    mocks.load = { status: "ok", nihoUserId: "operator-a", providers: [
      { id: "owned-provider", nihoUserId: "operator-a", displayName: "Owned provider", memberRole: "OWNER" },
      { id: "provider-a", nihoUserId: "seller-a", displayName: "Member provider", memberRole: "COHOST" },
    ] };
    expect(await calendarActor("provider-a")).toMatchObject({ response: { status: 503 } });
    expect(mocks.assignments).not.toHaveBeenCalled();
  });

  it("uses the authenticated NIHO identity for a cohost", async () => {
    mocks.load = { status: "ok", nihoUserId: "operator-a", providers: [{ id: "provider-a", nihoUserId: "operator-a", displayName: "Member provider", memberRole: "COHOST" }] };
    expect(await calendarActor("provider-a")).toMatchObject({ actor: { nihoUserId: "operator-a", calendarRoleCeiling: "EDITOR" }, access: { kind: "MEMBER", nihoRole: "COHOST" } });
    expect(mocks.assignments).not.toHaveBeenCalled();
  });
});
