import { beforeEach, describe, expect, it, vi } from "vitest";
import { StoreConflictError, StoreValidationError } from "@niho-experience/experience-store";

const mocks = vi.hoisted(() => ({
  csrf: true,
  enabled: true,
  load: vi.fn(),
  repo: { getCase: vi.fn(), updateCase: vi.fn() },
  roster: vi.fn(),
}));
vi.mock("server-only", () => ({}));
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
vi.mock("@/lib/admin/case-server", async () => {
  const { NextResponse } = await import("next/server");
  return {
    adminSupportCaseApiClient: () => ({ listSupportAdmins: mocks.roster }),
    adminSupportCaseFailureJson: (failure: { kind: string }) => NextResponse.json({ error: failure.kind }, { status: failure.kind === "rejected" ? 401 : 503 }),
  };
});

import { GET, POST } from "./route";

const BASE = "https://experience.example/admin/api/site-bookings/case";
const BOOKING = "0f8fad5b-d9cb-469f-a165-708677289501";
const COMMAND = "00000000-0000-4000-8000-000000000221";
const caseValue = { publicBookingId: BOOKING, assignedAdminUserId: "admin-b", internalMemo: "Private", revision: 1, updatedBy: "admin-a", updatedAtUtc: "2026-11-01T00:00:00.000Z", events: [] };
const post = (body: unknown) => new Request(BASE, { method: "POST", headers: { origin: "https://experience.example", "sec-fetch-site": "same-origin", "content-type": "application/json" }, body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.csrf = true;
  mocks.enabled = true;
  mocks.load.mockResolvedValue({ status: "ok", kind: "niho", actor: { id: "admin-a", displayName: null }, session: { idToken: "synthetic-id-token" }, verified: { actor: { id: "admin-a" } } });
  mocks.repo = { getCase: vi.fn(async () => null), updateCase: vi.fn(async () => caseValue) };
  mocks.roster.mockResolvedValue({ ok: true, data: { admins: [{ id: "admin-b", displayName: "担当Admin" }], truncated: false } });
});

describe("Experience Admin support case API", () => {
  it("reads only for a current Admin and returns private no-store data", async () => {
    const response = await GET(new Request(`${BASE}?publicBookingId=${BOOKING}`));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.repo.getCase).toHaveBeenCalledWith({ nihoUserId: "admin-a" }, BOOKING);
    mocks.load.mockResolvedValueOnce({ status: "rejected" });
    expect((await GET(new Request(`${BASE}?publicBookingId=${BOOKING}`))).status).toBe(401);
    expect((await GET(new Request(`${BASE}?publicBookingId=bad`))).status).toBe(400);
  });

  it("validates newly assigned Admins against the current roster before saving", async () => {
    const body = { publicBookingId: BOOKING, commandId: COMMAND, expectedRevision: 0, assignedAdminUserId: "admin-b", internalMemo: "Private" };
    expect((await POST(post(body))).status).toBe(200);
    expect(mocks.roster).toHaveBeenCalledTimes(1);
    expect(mocks.repo.updateCase).toHaveBeenCalledWith({ nihoUserId: "admin-a" }, BOOKING, {
      commandId: COMMAND, expectedRevision: 0, assignedAdminUserId: "admin-b", internalMemo: "Private",
    });
    mocks.roster.mockResolvedValueOnce({ ok: true, data: { admins: [], truncated: false } });
    expect((await POST(post({ ...body, commandId: "00000000-0000-4000-8000-000000000222" }))).status).toBe(409);
    expect(mocks.repo.updateCase).toHaveBeenCalledTimes(1);
  });

  it("lets an admin signed in with Google (ADR 0003) assign to themselves only, recorded by their adm_ actor ID, without calling NIHO", async () => {
    const admin = `adm_${"0".repeat(32)}`;
    mocks.load.mockResolvedValue({ status: "ok", kind: "experience", actor: { id: admin, displayName: "admin.sample@niho.life" }, session: { kind: "experience" } });
    const self = await POST(post({ publicBookingId: BOOKING, commandId: COMMAND, expectedRevision: 0, assignedAdminUserId: "SELF", internalMemo: null }));
    expect(self.status).toBe(200);
    expect(mocks.repo.updateCase).toHaveBeenLastCalledWith({ nihoUserId: admin }, BOOKING, expect.objectContaining({ assignedAdminUserId: admin }));
    const other = await POST(post({ publicBookingId: BOOKING, commandId: "00000000-0000-4000-8000-000000000222", expectedRevision: 1, assignedAdminUserId: "admin-b", internalMemo: null }));
    expect(other.status).toBe(409);
    expect(await other.json()).toEqual({ error: "assignee_unavailable" });
    expect(mocks.roster).not.toHaveBeenCalled();
  });

  it("allows the unchanged legacy assignment and self-assignment without inventing candidates", async () => {
    mocks.repo.getCase.mockResolvedValue(caseValue);
    const unchanged = await POST(post({ publicBookingId: BOOKING, commandId: COMMAND, expectedRevision: 1, assignedAdminUserId: "admin-b", internalMemo: "Private" }));
    expect(unchanged.status).toBe(200);
    expect(mocks.roster).not.toHaveBeenCalled();
    const self = await POST(post({ publicBookingId: BOOKING, commandId: "00000000-0000-4000-8000-000000000222", expectedRevision: 1, assignedAdminUserId: "SELF", internalMemo: null }));
    expect(self.status).toBe(200);
    expect(mocks.repo.updateCase).toHaveBeenLastCalledWith({ nihoUserId: "admin-a" }, BOOKING, expect.objectContaining({ assignedAdminUserId: "admin-a" }));
  });

  it("keeps same-origin, closed DTO, and store conflict boundaries", async () => {
    mocks.csrf = false;
    expect((await POST(post({}))).status).toBe(403);
    mocks.csrf = true;
    expect((await POST(post({ publicBookingId: BOOKING, commandId: COMMAND, expectedRevision: 0, assignedAdminUserId: null, internalMemo: null, extra: true }))).status).toBe(400);
    mocks.repo.updateCase.mockRejectedValueOnce(new StoreConflictError("revision"));
    expect((await POST(post({ publicBookingId: BOOKING, commandId: COMMAND, expectedRevision: 0, assignedAdminUserId: null, internalMemo: null }))).status).toBe(409);
    mocks.repo.updateCase.mockRejectedValueOnce(new StoreValidationError("invalid"));
    expect((await POST(post({ publicBookingId: BOOKING, commandId: COMMAND, expectedRevision: 0, assignedAdminUserId: null, internalMemo: null }))).status).toBe(400);
  });
});
