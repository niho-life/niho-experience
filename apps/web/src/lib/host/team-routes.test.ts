import { beforeEach, describe, expect, it, vi } from "vitest";
import { StoreAccessDeniedError, StoreRateLimitedError } from "@niho-experience/experience-store";

const state = vi.hoisted(() => ({
  config: { hostTeamEnabled: true, hostAccountsEnabled: true, apiMode: "http", siteUrl: "https://experience.example.test" },
  session: null as null | { kind: "experience"; hostAccountId: string } | { kind: "niho" },
  sessionError: null as Error | null,
  repository: null as null | Record<string, ReturnType<typeof vi.fn>>,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: state.config }));
vi.mock("@/lib/experience/store-server", () => ({ hostTeamRepository: () => state.repository }));
vi.mock("@/lib/host/server", () => ({
  readHostSession: async () => { if (state.sessionError) throw state.sessionError; return state.session; },
  noStoreJson: (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "private, no-store" } }),
}));

import { GET as listMembers } from "@/app/(host)/host/api/team/[providerId]/members/route";
import { POST as resolveMember } from "@/app/(host)/host/api/team/[providerId]/members/resolve/route";
import { DELETE as removeMember, PUT as addMember } from "@/app/(host)/host/api/team/[providerId]/members/[hostAccountId]/route";

const OWNER = `hst_${"01".repeat(16)}`;
const TARGET = `hst_${"02".repeat(16)}`;
const COMMAND = "10000000-0000-4000-8000-000000000001";
const context = { params: Promise.resolve({ providerId: "provider-a" }) };
const memberContext = { params: Promise.resolve({ providerId: "provider-a", hostAccountId: TARGET }) };
const headers = { origin: state.config.siteUrl, "sec-fetch-site": "same-origin", "content-type": "application/json" };
const request = (url: string, method = "GET", body?: unknown, custom = headers) => new Request(`${state.config.siteUrl}${url}`, {
  method, headers: custom, body: body === undefined ? undefined : JSON.stringify(body),
});

beforeEach(() => {
  Object.assign(state.config, { hostTeamEnabled: true, hostAccountsEnabled: true, apiMode: "http" });
  state.session = { kind: "experience", hostAccountId: OWNER };
  state.sessionError = null;
  state.repository = {
    list: vi.fn(async () => ({ contractVersion: 1, teamRevision: 0, members: [] })),
    resolve: vi.fn(async () => ({ contractVersion: 1, teamRevision: 0, candidate: null })),
    addCohost: vi.fn(async () => ({ ok: true })),
    removeCohost: vi.fn(async () => ({ ok: true })),
  };
});

describe("Experience-native host team routes", () => {
  it("separates flag, session kind and DB availability failures", async () => {
    state.config.hostTeamEnabled = false;
    expect((await listMembers(request("/host/api/team/provider-a/members"), context)).status).toBe(404);
    state.config.hostTeamEnabled = true; state.session = null;
    expect((await listMembers(request("/host/api/team/provider-a/members"), context)).status).toBe(401);
    state.session = { kind: "niho" };
    expect((await listMembers(request("/host/api/team/provider-a/members"), context)).status).toBe(401);
    state.session = { kind: "experience", hostAccountId: OWNER }; state.repository = null;
    expect((await listMembers(request("/host/api/team/provider-a/members"), context)).status).toBe(503);
    state.sessionError = new Error("synthetic database outage");
    expect((await listMembers(request("/host/api/team/provider-a/members"), context)).status).toBe(503);
  });

  it("passes only the native session actor and maps fresh membership refusal before returning data", async () => {
    const response = await listMembers(request("/host/api/team/provider-a/members"), context);
    expect(response.status).toBe(200);
    expect(state.repository?.list).toHaveBeenCalledWith({ providerId: "provider-a", hostAccountId: OWNER, repository: state.repository });
    const repository = state.repository!;
    repository.list!.mockRejectedValueOnce(new StoreAccessDeniedError());
    expect((await listMembers(request("/host/api/team/provider-a/members"), context)).status).toBe(403);
    repository.list!.mockRejectedValueOnce(new Error("synthetic database outage"));
    expect((await listMembers(request("/host/api/team/provider-a/members"), context)).status).toBe(503);
  });

  it("requires same-origin exact resolve and exposes rate-limit timing without echoing the email", async () => {
    const crossSite = request("/host/api/team/provider-a/members/resolve", "POST", { email: "candidate@example.test" }, { ...headers, origin: "https://evil.example.test", "sec-fetch-site": "cross-site" });
    expect((await resolveMember(crossSite, context)).status).toBe(403);
    const resolved = await resolveMember(request("/host/api/team/provider-a/members/resolve", "POST", { email: "candidate@example.test" }), context);
    expect(resolved.status).toBe(200);
    expect(state.repository?.resolve).toHaveBeenCalledWith(expect.objectContaining({ providerId: "provider-a", hostAccountId: OWNER, email: "candidate@example.test" }));
    const repository = state.repository!;
    repository.resolve!.mockRejectedValueOnce(new StoreRateLimitedError(37));
    const limited = await resolveMember(request("/host/api/team/provider-a/members/resolve", "POST", { email: "private@example.test" }), context);
    expect(limited.status).toBe(429); expect(limited.headers.get("retry-after")).toBe("37");
    expect(await limited.text()).not.toContain("private@example.test");
  });

  it("sends CAS and the fixed command to add/remove, rejecting unknown fields", async () => {
    const body = { commandId: COMMAND, expectedRevision: 3 };
    expect((await addMember(request(`/host/api/team/provider-a/members/${TARGET}`, "PUT", { ...body, email: "leak@example.test" }), memberContext)).status).toBe(400);
    expect((await addMember(request(`/host/api/team/provider-a/members/${TARGET}`, "PUT", body), memberContext)).status).toBe(200);
    expect(state.repository?.addCohost).toHaveBeenCalledWith(expect.objectContaining({ providerId: "provider-a", hostAccountId: OWNER, targetHostAccountId: TARGET, ...body }));
    expect((await removeMember(request(`/host/api/team/provider-a/members/${TARGET}`, "DELETE", body), memberContext)).status).toBe(200);
    expect(state.repository?.removeCohost).toHaveBeenCalledWith(expect.objectContaining({ targetHostAccountId: TARGET, ...body }));
  });
});
