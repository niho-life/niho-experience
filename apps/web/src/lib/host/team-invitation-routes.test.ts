import { beforeEach, describe, expect, it, vi } from "vitest";
import { StoreAccessDeniedError, StoreRateLimitedError } from "@niho-experience/experience-store";
import { parseTeamInvitationCreated, parseTeamInvitations } from "./team-contract";

/** メンバーの招待 (#636): the OWNER's API, against a stubbed store. */
const state = vi.hoisted(() => ({
  config: { hostTeamEnabled: true, hostTeamInvitationsEnabled: true, hostAccountsEnabled: true, apiMode: "http", siteUrl: "https://experience.example.test" },
  session: null as null | { kind: "experience"; hostAccountId: string } | { kind: "niho" },
  team: {} as object | null,
  invitations: null as null | Record<string, ReturnType<typeof import("vitest").vi.fn>>,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: state.config }));
vi.mock("@/lib/experience/store-server", () => ({ hostTeamRepository: () => state.team, hostTeamInvitations: () => state.invitations }));
vi.mock("@/lib/host/server", () => ({
  readHostSession: async () => state.session,
  noStoreJson: (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "private, no-store" } }),
}));

import { GET as listInvitations, POST as invite } from "@/app/(host)/host/api/team/[providerId]/invitations/route";
import { DELETE as revokeInvitation } from "@/app/(host)/host/api/team/[providerId]/invitations/[invitationId]/route";

const OWNER = `hst_${"01".repeat(16)}`;
const INVITATION = "20000000-0000-4000-8000-000000000001";
const context = { params: Promise.resolve({ providerId: "provider-a" }) };
const itemContext = { params: Promise.resolve({ providerId: "provider-a", invitationId: INVITATION }) };
const headers = { origin: state.config.siteUrl, "sec-fetch-site": "same-origin", "content-type": "application/json" };
const request = (url: string, method = "GET", body?: unknown, custom = headers) => new Request(`${state.config.siteUrl}${url}`, {
  method, headers: custom, body: body === undefined ? undefined : JSON.stringify(body),
});
const LISTED = { invitationId: INVITATION, email: "invitee@example.test", createdAtUtc: "2026-11-25T00:00:00.000Z", expiresAtUtc: "2026-12-02T00:00:00.000Z", state: "QUEUED" };

beforeEach(() => {
  Object.assign(state.config, { hostTeamEnabled: true, hostTeamInvitationsEnabled: true, hostAccountsEnabled: true, apiMode: "http" });
  state.session = { kind: "experience", hostAccountId: OWNER };
  state.team = {};
  state.invitations = {
    list: vi.fn(async () => [LISTED]),
    create: vi.fn(async () => ({ kind: "created", invitationId: INVITATION, expiresAtUtc: LISTED.expiresAtUtc, superseded: false })),
    revoke: vi.fn(async () => true),
  };
});

describe("team invitation API", () => {
  it("is a 404 for every method while the flag is off, before anything else is read", async () => {
    state.config.hostTeamInvitationsEnabled = false;
    expect((await listInvitations(request("/host/api/team/provider-a/invitations"), context)).status).toBe(404);
    const crossSite = { ...headers, origin: "https://evil.example.test", "sec-fetch-site": "cross-site" };
    expect((await invite(request("/host/api/team/provider-a/invitations", "POST", { email: "a@example.test" }, crossSite), context)).status).toBe(404);
    expect((await revokeInvitation(request(`/host/api/team/provider-a/invitations/${INVITATION}`, "DELETE"), itemContext)).status).toBe(404);
    expect(state.invitations!.list).not.toHaveBeenCalled();
    expect(state.invitations!.create).not.toHaveBeenCalled();
    expect(state.invitations!.revoke).not.toHaveBeenCalled();
  });

  it("needs a native session, the team and the store, and refuses a query string", async () => {
    state.session = null;
    expect((await listInvitations(request("/host/api/team/provider-a/invitations"), context)).status).toBe(401);
    state.session = { kind: "niho" };
    expect((await listInvitations(request("/host/api/team/provider-a/invitations"), context)).status).toBe(401);
    state.session = { kind: "experience", hostAccountId: OWNER };
    expect((await listInvitations(request("/host/api/team/provider-a/invitations?x=1"), context)).status).toBe(400);
    state.invitations = null;
    expect((await listInvitations(request("/host/api/team/provider-a/invitations"), context)).status).toBe(503);
  });

  it("lists the open invitations in the contract's shape, for the session's own account", async () => {
    const response = await listInvitations(request("/host/api/team/provider-a/invitations"), context);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const body = await response.json();
    expect(parseTeamInvitations(body)).toEqual({ contractVersion: 1, invitations: [{ id: INVITATION, email: "invitee@example.test", createdAt: LISTED.createdAtUtc, expiresAt: LISTED.expiresAtUtc, state: "QUEUED" }] });
    expect(state.invitations!.list).toHaveBeenCalledWith({ providerId: "provider-a", hostAccountId: OWNER, nowUtc: expect.any(String) });
    state.invitations!.list!.mockRejectedValueOnce(new StoreAccessDeniedError());
    expect((await listInvitations(request("/host/api/team/provider-a/invitations"), context)).status).toBe(403);
    state.invitations!.list!.mockRejectedValueOnce(new Error("synthetic database outage"));
    expect((await listInvitations(request("/host/api/team/provider-a/invitations"), context)).status).toBe(503);
  });

  it("creates an invitation: 201 with the row, 409 for a member and for too many, 400 for a bad body, 429 with retry-after", async () => {
    const created = await invite(request("/host/api/team/provider-a/invitations", "POST", { email: "invitee@example.test" }), context);
    expect(created.status).toBe(201);
    expect(parseTeamInvitationCreated(await created.json())?.invitation.id).toBe(INVITATION);
    expect(state.invitations!.create).toHaveBeenCalledWith({ providerId: "provider-a", hostAccountId: OWNER, email: "invitee@example.test", nowUtc: expect.any(String) });

    const crossSite = { ...headers, origin: "https://evil.example.test", "sec-fetch-site": "cross-site" };
    expect((await invite(request("/host/api/team/provider-a/invitations", "POST", { email: "a@example.test" }, crossSite), context)).status).toBe(403);
    expect((await invite(request("/host/api/team/provider-a/invitations", "POST", { email: "a@example.test", role: "OWNER" }), context)).status).toBe(400);
    expect((await invite(request("/host/api/team/provider-a/invitations", "POST", { email: "x".repeat(300) }), context)).status).toBe(400);

    const repository = state.invitations!;
    repository.create!.mockResolvedValueOnce({ kind: "already-member" });
    const member = await invite(request("/host/api/team/provider-a/invitations", "POST", { email: "owner@example.test" }), context);
    expect(member.status).toBe(409);
    expect(await member.json()).toEqual({ error: "already_member" });
    repository.create!.mockResolvedValueOnce({ kind: "too-many-open" });
    const many = await invite(request("/host/api/team/provider-a/invitations", "POST", { email: "more@example.test" }), context);
    expect(many.status).toBe(409);
    expect(await many.json()).toEqual({ error: "too_many_open" });
    repository.create!.mockRejectedValueOnce(new StoreRateLimitedError(37));
    const limited = await invite(request("/host/api/team/provider-a/invitations", "POST", { email: "private@example.test" }), context);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("37");
    expect(await limited.text()).not.toContain("private@example.test");
    repository.create!.mockRejectedValueOnce(new StoreAccessDeniedError());
    expect((await invite(request("/host/api/team/provider-a/invitations", "POST", { email: "a@example.test" }), context)).status).toBe(403);
  });

  it("takes an invitation back: 204, or 404 when it is not open, and only from the same origin", async () => {
    const url = `/host/api/team/provider-a/invitations/${INVITATION}`;
    const response = await revokeInvitation(request(url, "DELETE"), itemContext);
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(state.invitations!.revoke).toHaveBeenCalledWith({ providerId: "provider-a", hostAccountId: OWNER, invitationId: INVITATION, nowUtc: expect.any(String) });
    state.invitations!.revoke!.mockResolvedValueOnce(false);
    expect((await revokeInvitation(request(url, "DELETE"), itemContext)).status).toBe(404);
    const crossSite = { ...headers, origin: "https://evil.example.test", "sec-fetch-site": "cross-site" };
    expect((await revokeInvitation(request(url, "DELETE", undefined, crossSite), itemContext)).status).toBe(403);
    state.invitations!.revoke!.mockRejectedValueOnce(new StoreAccessDeniedError());
    expect((await revokeInvitation(request(url, "DELETE"), itemContext)).status).toBe(403);
  });
});
