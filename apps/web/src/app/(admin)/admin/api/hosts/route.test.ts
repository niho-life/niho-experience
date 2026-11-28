import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  csrf: true, enabled: true, load: vi.fn(),
  list: vi.fn(), get: vi.fn(), suspend: vi.fn(), clear: vi.fn(), suspendAccount: vi.fn(), reactivateAccount: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: { get experiencePublicationsEnabled() { return mocks.enabled; } } }));
vi.mock("@/lib/admin/server", async () => {
  const { NextResponse } = await import("next/server");
  return { isAdminHttp: () => true, adminMutationAllowed: () => mocks.csrf, loadAdminHttpSession: mocks.load,
    adminJson: (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "cache-control": "private, no-store" } }) };
});
vi.mock("@/lib/experience/store-server", () => ({
  experiencePublicationRepository: () => ({ listAdminHosts: mocks.list, getAdminHost: mocks.get, suspendProviderByOperations: mocks.suspend, clearProviderOperationsSuspension: mocks.clear }),
  adminHostAccounts: () => ({ suspendHostAccount: mocks.suspendAccount, reactivateHostAccount: mocks.reactivateAccount }),
}));

import { StoreNotFoundError, ExperiencePublicationBlockedError } from "@niho-experience/experience-store";
import { GET } from "./route";
import { GET as getHost } from "./[providerId]/route";
import { POST as suspend } from "./[providerId]/suspend/route";
import { POST as clear } from "./[providerId]/clear-suspension/route";
import { POST as suspendAccount } from "./accounts/[accountId]/suspend/route";
import { POST as reactivateAccount } from "./accounts/[accountId]/reactivate/route";

const ACCOUNT = `hst_${"a".repeat(32)}`;
const post = (path: string, body: unknown = {}, type = "application/json") => new Request(`https://experience.example/admin/api/hosts/${path}`, {
  method: "POST", headers: { origin: "https://experience.example", "content-type": type }, body: typeof body === "string" ? body : JSON.stringify(body),
});
const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) }) as never;

beforeEach(() => {
  vi.clearAllMocks(); mocks.csrf = true; mocks.enabled = true;
  mocks.load.mockResolvedValue({ status: "ok", kind: "google", actor: { id: "admin-a", displayName: null } });
  mocks.list.mockResolvedValue([{ providerId: "prv_1" }]);
  mocks.suspend.mockResolvedValue({ changed: true, suspendedProducts: 2 });
  mocks.clear.mockResolvedValue({ changed: true, suspendedProducts: 2 });
  mocks.suspendAccount.mockResolvedValue("CHANGED");
  mocks.reactivateAccount.mockResolvedValue("UNCHANGED");
});

describe("Admin hosts API (#711)", () => {
  it("lists hosts for a signed-in Admin only, without query keys, and is closed while the feature is off", async () => {
    const response = await GET(new Request("https://experience.example/admin/api/hosts"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ hosts: [{ providerId: "prv_1" }] });
    expect(mocks.list).toHaveBeenCalledWith({ nihoUserId: "admin-a" });
    expect((await GET(new Request("https://experience.example/admin/api/hosts?q=x"))).status).toBe(400);
    mocks.load.mockResolvedValue({ status: "signed-out" });
    expect((await GET(new Request("https://experience.example/admin/api/hosts"))).status).toBe(401);
    mocks.load.mockResolvedValue({ status: "error" });
    expect((await GET(new Request("https://experience.example/admin/api/hosts"))).status).toBe(503);
    mocks.enabled = false;
    expect((await GET(new Request("https://experience.example/admin/api/hosts"))).status).toBe(404);
  });

  it("reads one host by its ID (so a host older than the newest 500 is found), and says 404 for an unknown one", async () => {
    mocks.get.mockResolvedValue({ providerId: "prv_1" });
    const found = await getHost(new Request("https://experience.example/admin/api/hosts/prv_1"), ctx({ providerId: "prv_1" }));
    expect(found.status).toBe(200);
    expect(await found.json()).toEqual({ host: { providerId: "prv_1" } });
    expect(mocks.get).toHaveBeenCalledWith({ nihoUserId: "admin-a" }, "prv_1");
    mocks.get.mockResolvedValue(null);
    expect((await getHost(new Request("https://experience.example/admin/api/hosts/prv_9"), ctx({ providerId: "prv_9" }))).status).toBe(404);
    expect((await getHost(new Request("https://experience.example/admin/api/hosts/%20"), ctx({ providerId: " " }))).status).toBe(400);
    expect((await getHost(new Request("https://experience.example/admin/api/hosts/prv_1?x=1"), ctx({ providerId: "prv_1" }))).status).toBe(400);
    mocks.load.mockResolvedValue({ status: "signed-out" });
    expect((await getHost(new Request("https://experience.example/admin/api/hosts/prv_1"), ctx({ providerId: "prv_1" }))).status).toBe(401);
  });

  it("suspends a host with a machine reason code, same origin and JSON only", async () => {
    const ok = await suspend(post("prv_1/suspend", { reasonCode: "POLICY_VIOLATION" }), ctx({ providerId: "prv_1" }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ providerId: "prv_1", changed: true, suspendedProducts: 2 });
    expect(mocks.suspend).toHaveBeenCalledWith({ nihoUserId: "admin-a" }, "prv_1", "POLICY_VIOLATION");
    mocks.csrf = false;
    expect((await suspend(post("prv_1/suspend", { reasonCode: "X" }), ctx({ providerId: "prv_1" }))).status).toBe(403);
    mocks.csrf = true;
    expect((await suspend(post("prv_1/suspend", { reasonCode: "x" }), ctx({ providerId: "prv_1" }))).status).toBe(400);
    expect((await suspend(post("prv_1/suspend", {}), ctx({ providerId: "prv_1" }))).status).toBe(400);
    expect((await suspend(post("prv_1/suspend", { reasonCode: "X", extra: 1 }), ctx({ providerId: "prv_1" }))).status).toBe(400);
    expect((await suspend(post("prv_1/suspend", "not json"), ctx({ providerId: "prv_1" }))).status).toBe(400);
    expect((await suspend(post("prv_1/suspend", { reasonCode: "X" }, "text/plain"), ctx({ providerId: "prv_1" }))).status).toBe(415);
    expect((await suspend(post("%20/suspend", { reasonCode: "X" }), ctx({ providerId: " " }))).status).toBe(400);
    expect(mocks.suspend).toHaveBeenCalledTimes(1);
    mocks.suspend.mockRejectedValueOnce(new StoreNotFoundError("provider"));
    expect((await suspend(post("prv_9/suspend", { reasonCode: "X" }), ctx({ providerId: "prv_9" }))).status).toBe(404);
    mocks.suspend.mockRejectedValueOnce(new Error("boom"));
    expect((await suspend(post("prv_1/suspend", { reasonCode: "X" }), ctx({ providerId: "prv_1" }))).status).toBe(503);
  });

  it("lifts a host's suspension and reports a blocked or unknown host", async () => {
    const ok = await clear(post("prv_1/clear-suspension"), ctx({ providerId: "prv_1" }));
    expect(ok.status).toBe(200);
    expect(mocks.clear).toHaveBeenCalledWith({ nihoUserId: "admin-a" }, "prv_1");
    expect((await clear(post("prv_1/clear-suspension", { reasonCode: "X" }), ctx({ providerId: "prv_1" }))).status).toBe(400);
    mocks.clear.mockRejectedValueOnce(new StoreNotFoundError("provider"));
    expect((await clear(post("prv_9/clear-suspension"), ctx({ providerId: "prv_9" }))).status).toBe(404);
    mocks.clear.mockRejectedValueOnce(new ExperiencePublicationBlockedError(["PROVIDER_SUSPENDED"]));
    const blocked = await clear(post("prv_1/clear-suspension"), ctx({ providerId: "prv_1" }));
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toEqual({ error: "blocked", blockers: ["PROVIDER_SUSPENDED"] });
  });

  it("suspends and reactivates a host account by its hst_ ID only", async () => {
    const suspended = await suspendAccount(post(`accounts/${ACCOUNT}/suspend`), ctx({ accountId: ACCOUNT }));
    expect(await suspended.json()).toEqual({ hostAccountId: ACCOUNT, changed: true });
    expect(mocks.suspendAccount).toHaveBeenCalledWith({ hostAccountId: ACCOUNT, actorId: "admin-a", nowUtc: expect.stringMatching(/^\d{4}-/) });
    const reactivated = await reactivateAccount(post(`accounts/${ACCOUNT}/reactivate`), ctx({ accountId: ACCOUNT }));
    expect(await reactivated.json()).toEqual({ hostAccountId: ACCOUNT, changed: false });
    expect((await suspendAccount(post("accounts/niho-user-1/suspend"), ctx({ accountId: "niho-user-1" }))).status).toBe(400);
    mocks.csrf = false;
    expect((await suspendAccount(post(`accounts/${ACCOUNT}/suspend`), ctx({ accountId: ACCOUNT }))).status).toBe(403);
    mocks.csrf = true;
    mocks.suspendAccount.mockRejectedValueOnce(new StoreNotFoundError("Host account"));
    expect((await suspendAccount(post(`accounts/${ACCOUNT}/suspend`), ctx({ accountId: ACCOUNT }))).status).toBe(404);
  });
});
