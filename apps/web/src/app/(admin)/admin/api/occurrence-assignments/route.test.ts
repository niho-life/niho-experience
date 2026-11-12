import { beforeEach, describe, expect, it, vi } from "vitest";
import { StoreConflictError } from "@niho-experience/experience-store";

const state = vi.hoisted(() => ({
  config: { occurrenceAssignmentEnabled: true, managedSalesEnabled: true },
  http: true,
  mutation: true,
  load: vi.fn(),
  repository: { adminList: vi.fn(), adminCandidates: vi.fn(), adminHistory: vi.fn(), adminRecord: vi.fn(), adminSetAgreedFee: vi.fn() },
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ get config() { return state.config; } }));
vi.mock("@/lib/admin/server", async () => {
  const { NextResponse } = await import("next/server");
  return {
    isAdminHttp: () => state.http,
    adminMutationAllowed: () => state.mutation,
    loadAdminHttpSession: state.load,
    adminJson: (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "cache-control": "private, no-store" } }),
  };
});
vi.mock("@/lib/experience/store-server", () => ({ occurrenceAssignmentRepository: () => state.repository }));

import { GET, POST } from "./route";

const URL = "https://experience.example/admin/api/occurrence-assignments";
const COMMAND = "0f8fad5b-d9cb-469f-a165-708677289501";
const post = (body: unknown) => new Request(URL, { method: "POST", headers: { "content-type": "application/json", origin: URL, "sec-fetch-site": "same-origin" }, body: JSON.stringify(body) });
const base = { providerId: "provider-synthetic", occurrenceId: "occurrence-synthetic", commandId: COMMAND };

beforeEach(() => {
  vi.clearAllMocks();
  state.config = { occurrenceAssignmentEnabled: true, managedSalesEnabled: true };
  state.http = true; state.mutation = true;
  state.load.mockResolvedValue({ status: "ok", actor: { id: "admin-synthetic" } });
});

describe("Admin occurrence assignments (#535)", () => {
  it("is not found while the flag is off or outside the Admin HTTP mode, and refuses without an Admin", async () => {
    state.config.occurrenceAssignmentEnabled = false;
    expect((await GET(new Request(URL))).status).toBe(404);
    expect((await POST(post({ ...base, action: "RELEASE" }))).status).toBe(404);
    state.config.occurrenceAssignmentEnabled = true; state.http = false;
    expect((await GET(new Request(URL))).status).toBe(404);
    state.http = true; state.load.mockResolvedValue({ status: "signed-out" });
    expect((await GET(new Request(URL))).status).toBe(401);
    expect(state.repository.adminList).not.toHaveBeenCalled();
  });

  it("lists, and reads one occurrence's candidates and history", async () => {
    state.repository.adminList.mockResolvedValue([]);
    expect(await (await GET(new Request(URL))).json()).toEqual({ rows: [] });
    state.repository.adminCandidates.mockResolvedValue([{ nihoUserId: "u1", label: "A", kind: "MEMBER" }]);
    state.repository.adminHistory.mockResolvedValue([]);
    const read = await GET(new Request(`${URL}?providerId=provider-synthetic&occurrenceId=occurrence-synthetic`));
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ candidates: [{ nihoUserId: "u1", label: "A", kind: "MEMBER" }], history: [] });
    expect((await GET(new Request(`${URL}?providerId=provider-synthetic`))).status).toBe(400);
  });

  it("records for someone as the office and returns 409 when another person already took it", async () => {
    state.repository.adminRecord.mockResolvedValueOnce({ outcome: "ASSIGNED", repeated: false });
    const ok = await POST(post({ ...base, action: "CLAIM", subjectNihoUserId: "user-1", reason: "LINEで返事" }));
    expect(ok.status).toBe(200);
    expect(state.repository.adminRecord).toHaveBeenCalledWith({ nihoUserId: "admin-synthetic" }, { ...base, action: "CLAIM", subjectNihoUserId: "user-1", reason: "LINEで返事" });
    state.repository.adminRecord.mockResolvedValueOnce({ outcome: "TAKEN", repeated: false });
    const taken = await POST(post({ ...base, action: "CLAIM", subjectNihoUserId: "user-2" }));
    expect(taken.status).toBe(409);
    expect((await taken.json()).error).toBe("already_assigned");
    state.repository.adminRecord.mockRejectedValueOnce(new StoreConflictError("closed"));
    expect((await POST(post({ ...base, action: "DECLINE", subjectNihoUserId: "user-1" }))).status).toBe(409);
  });

  it("sets the agreed fee by hand and rejects malformed or forged input", async () => {
    state.repository.adminSetAgreedFee.mockResolvedValue({ outcome: "FEE_SET", repeated: false });
    expect((await POST(post({ ...base, action: "SET_FEE", agreedFeeYen: 5000 }))).status).toBe(200);
    expect(state.repository.adminSetAgreedFee).toHaveBeenCalledWith({ nihoUserId: "admin-synthetic" }, { ...base, agreedFeeYen: 5000 });
    expect((await POST(post({ ...base, action: "SET_FEE", agreedFeeYen: "5000" }))).status).toBe(400);
    expect((await POST(post({ ...base, action: "CLAIM" }))).status).toBe(400);
    expect((await POST(post({ ...base, action: "APPROVE" }))).status).toBe(400);
    expect((await POST(post({ ...base, action: "RELEASE", approvalStatus: "APPROVED" }))).status).toBe(400);
    expect((await POST(post({ ...base, commandId: "nope", action: "RELEASE" }))).status).toBe(400);
    state.mutation = false;
    expect((await POST(post({ ...base, action: "RELEASE" }))).status).toBe(403);
    expect(state.repository.adminRecord).not.toHaveBeenCalled();
  });
});
