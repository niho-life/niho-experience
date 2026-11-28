import { beforeEach, expect, it, vi } from "vitest";
import { StoreConflictError, StoreNotFoundError } from "@niho-experience/experience-store";

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  mutationAllowed: vi.fn(() => true),
  repository: { getForBooking: vi.fn(), adminAct: vi.fn() },
  config: { hostAgentPayoutsEnabled: false },
}));

vi.mock("@/lib/config", () => ({ config: mocks.config }));
vi.mock("@/lib/admin/server", () => ({
  isAdminHttp: () => true,
  adminMutationAllowed: mocks.mutationAllowed,
  loadAdminHttpSession: mocks.load,
  adminJson: (body: unknown, status = 200) => Response.json(body, { status }),
}));
vi.mock("@/lib/experience/store-server", () => ({
  agentPayoutRepository: () => mocks.repository,
}));

import { GET, POST } from "./route";

const bookingId = "00000000-0000-4000-8000-000000000221";
const url = `https://experience.example/admin/api/site-bookings/agent-payout/${bookingId}`;
const context = { params: Promise.resolve({ publicBookingId: bookingId }) };
const post = (body: unknown, headers: Record<string, string> = { "content-type": "application/json" }) => new Request(url, { method: "POST", headers, body: JSON.stringify(body) });

const agentPayoutsOn = () => { mocks.config.hostAgentPayoutsEnabled = true; };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.config.hostAgentPayoutsEnabled = false;
  mocks.mutationAllowed.mockReturnValue(true);
});

it("is a 404 without the payout flag, before the session is even read", async () => {
  expect((await GET(new Request(url), context)).status).toBe(404);
  expect((await POST(post({ action: "RECALCULATE", expectedVersion: 1 }), context)).status).toBe(404);
  expect(mocks.load).not.toHaveBeenCalled();
});

it("needs an Admin session and a same-origin JSON request", async () => {
  agentPayoutsOn();
  mocks.load.mockResolvedValueOnce({ status: "rejected" });
  expect((await GET(new Request(url), context)).status).toBe(401);
  mocks.mutationAllowed.mockReturnValueOnce(false);
  expect((await POST(post({ action: "RECALCULATE", expectedVersion: 1 }), context)).status).toBe(403);
  mocks.load.mockResolvedValue({ status: "ok", actor: { id: "admin-a" } });
  expect((await POST(post({ action: "RECALCULATE", expectedVersion: 1 }, { "content-type": "text/plain" }), context)).status).toBe(400);
  expect((await GET(new Request(`${url}?x=1`), context)).status).toBe(400);
  expect(mocks.repository.adminAct).not.toHaveBeenCalled();
});

it("reads the payout, and runs each operation as the signed-in admin with its version", async () => {
  agentPayoutsOn();
  mocks.load.mockResolvedValue({ status: "ok", actor: { id: "admin-a" } });
  mocks.repository.getForBooking.mockResolvedValueOnce({ payout: { status: "SCHEDULED" } }).mockResolvedValueOnce(null);
  expect(await (await GET(new Request(url), context)).json()).toEqual({ detail: { payout: { status: "SCHEDULED" } } });
  expect((await GET(new Request(url), context)).status).toBe(404);
  mocks.repository.adminAct.mockResolvedValue({ payout: { status: "SCHEDULED" } });
  for (const body of [
    { action: "RECALCULATE", expectedVersion: 3 },
    { action: "RECREATE", expectedVersion: 3, confirmedNotSent: true, note: "Stripe で確認" },
    { action: "CLOSE", expectedVersion: 3, note: "別の方法で支払い済み" },
    { action: "OFFSET", expectedVersion: 2, adjustmentId: "00000000-0000-4000-8000-000000000444" },
    { action: "LOSS", expectedVersion: 2, adjustmentId: "00000000-0000-4000-8000-000000000444", note: "NIHO が負担" },
    { action: "RESUME_ADJUSTMENT", expectedVersion: 2, adjustmentId: "00000000-0000-4000-8000-000000000444" },
  ]) {
    expect((await POST(post(body), context)).status, body.action).toBe(200);
    expect(mocks.repository.adminAct).toHaveBeenLastCalledWith("admin-a", bookingId, body);
  }
});

it("refuses unknown actions and fields, and answers a changed version with 409", async () => {
  agentPayoutsOn();
  mocks.load.mockResolvedValue({ status: "ok", actor: { id: "admin-a" } });
  for (const body of [{ action: "PAY", expectedVersion: 1 }, { action: "CLOSE" }, { action: "CLOSE", expectedVersion: "1" }, { action: "CLOSE", expectedVersion: 1, amount: 5 },
    { action: "OFFSET", expectedVersion: 1, adjustmentId: "nope" }]) {
    expect((await POST(post(body), context)).status).toBe(400);
  }
  expect(mocks.repository.adminAct).not.toHaveBeenCalled();
  mocks.repository.adminAct.mockRejectedValueOnce(new StoreConflictError("changed")).mockRejectedValueOnce(new StoreNotFoundError("agent payout"));
  expect((await POST(post({ action: "RECALCULATE", expectedVersion: 1 }), context)).status).toBe(409);
  expect((await POST(post({ action: "RECALCULATE", expectedVersion: 1 }), context)).status).toBe(404);
});
