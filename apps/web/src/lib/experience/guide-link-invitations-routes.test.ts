import { beforeEach, describe, expect, it, vi } from "vitest";
import { StoreAccessDeniedError, StoreConflictError } from "@niho-experience/experience-store";

const mocks = vi.hoisted(() => ({
  editorContext: vi.fn(),
  hostContext: vi.fn(),
  editorAllowed: vi.fn(() => true),
  repository: {
    listOwnPendingLinkInvitations: vi.fn(),
    acceptLinkInvitation: vi.fn(),
    declineLinkInvitation: vi.fn(),
    listProviderLinkInvitations: vi.fn(),
    revokeLinkInvitation: vi.fn(),
  },
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/editor/guide-api-server", async () => {
  const { NextResponse } = await import("next/server");
  const { StoreAccessDeniedError, StoreConflictError, StoreValidationError, StoreNotFoundError } = await import("@niho-experience/experience-store");
  const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-robots-tag": "noindex, nofollow" } });
  return {
    guideApiJson: json,
    guideApiError: (error: unknown) => error instanceof StoreConflictError ? json({ error: "conflict" }, 409)
      : error instanceof StoreAccessDeniedError || error instanceof StoreNotFoundError ? json({ error: "not_found" }, 404)
        : error instanceof StoreValidationError ? json({ error: "invalid_input" }, 400) : json({ error: "unavailable" }, 503),
    guideApiMutationAllowed: mocks.editorAllowed,
    loadGuideApiContext: mocks.editorContext,
    readGuideApiJson: async (request: Request) => {
      if (new URL(request.url).search || request.headers.get("content-type") !== "application/json") return { ok: false };
      try { return { ok: true, value: await request.json() }; } catch { return { ok: false }; }
    },
  };
});
vi.mock("@/lib/host/guide-link-api-server", () => ({ loadHostGuideLinkContext: mocks.hostContext }));
vi.mock("@/lib/host/server", () => ({
  noStoreJson: (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-robots-tag": "noindex, nofollow" } }),
  siteOrigin: () => "https://experience.example.test",
}));

import { GET as writerList } from "@/app/(editor)/editor/api/guide-link-invitations/route";
import { POST as writerRespond } from "@/app/(editor)/editor/api/guide-link-invitations/[invitationId]/[action]/route";
import { GET as hostList } from "@/app/(host)/host/api/guide-link-invitations/providers/[providerId]/route";
import { POST as hostRevoke } from "@/app/(host)/host/api/guide-link-invitations/[invitationId]/revoke/route";

const SITE = "https://experience.example.test";
const id = "00000000-0000-4000-8000-000000000190";
const invitation = {
  id,
  providerId: "provider-test",
  writerNihoUserId: "writer-secret",
  invitedByNihoUserId: "owner-secret",
  state: "PENDING",
  generation: 2,
  invitedAtUtc: "2026-10-29T00:00:00.000Z",
};
const headers = { origin: SITE, "sec-fetch-site": "same-origin", "content-type": "application/json" };
const jsonRequest = (path: string, body: unknown, requestHeaders = headers) => new Request(`${SITE}${path}`, { method: "POST", headers: requestHeaders, body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.editorAllowed.mockReturnValue(true);
  mocks.editorContext.mockResolvedValue({ ok: true, value: { actor: { nihoUserId: "writer-secret" }, repository: mocks.repository } });
  mocks.hostContext.mockResolvedValue({ ok: true, value: { actor: { nihoUserId: "owner-secret" }, repository: mocks.repository } });
  mocks.repository.listOwnPendingLinkInvitations.mockResolvedValue([invitation]);
  mocks.repository.listProviderLinkInvitations.mockResolvedValue([invitation]);
  mocks.repository.acceptLinkInvitation.mockResolvedValue({ ...invitation, state: "ACCEPTED", acceptedAtUtc: "2026-10-29T01:00:00.000Z" });
  mocks.repository.declineLinkInvitation.mockResolvedValue({ ...invitation, state: "DECLINED", declinedAtUtc: "2026-10-29T01:00:00.000Z" });
  mocks.repository.revokeLinkInvitation.mockResolvedValue({ ...invitation, state: "REVOKED", revokedAtUtc: "2026-10-29T01:00:00.000Z" });
});

describe("guide link invitation BFF", () => {
  it("shows only the fields needed for writer and host actions", async () => {
    const writer = await writerList(new Request(`${SITE}/editor/api/guide-link-invitations`));
    const host = await hostList(new Request(`${SITE}/host/api/guide-link-invitations/providers/provider-test`), { params: Promise.resolve({ providerId: "provider-test" }) });
    expect(writer.status).toBe(200);
    expect(host.status).toBe(200);
    expect(JSON.stringify(await writer.json())).not.toMatch(/writer-secret|owner-secret/);
    expect(JSON.stringify(await host.json())).not.toMatch(/writer-secret|owner-secret|provider-test/);
    expect(writer.headers.get("cache-control")).toBe("private, no-store");
    expect(host.headers.get("cache-control")).toBe("private, no-store");
  });

  it("requires a current generation and same-origin mutation", async () => {
    const action = { params: Promise.resolve({ invitationId: id, action: "accept" }) };
    const route = `/editor/api/guide-link-invitations/${id}/accept`;
    expect((await writerRespond(jsonRequest(route, { generation: 0 }), action)).status).toBe(400);
    mocks.editorAllowed.mockReturnValue(false);
    expect((await writerRespond(jsonRequest(route, { generation: 2 }), action)).status).toBe(403);
    mocks.editorAllowed.mockReturnValue(true);
    const accepted = await writerRespond(jsonRequest(route, { generation: 2 }), action);
    expect(accepted.status).toBe(200);
    expect(mocks.repository.acceptLinkInvitation).toHaveBeenCalledWith({ nihoUserId: "writer-secret" }, id, 2);
    expect(JSON.stringify(await accepted.json())).not.toMatch(/writer-secret|owner-secret/);
  });

  it("keeps permission failures private and rejects stale revocation", async () => {
    const route = `/host/api/guide-link-invitations/${id}/revoke`;
    const context = { params: Promise.resolve({ invitationId: id }) };
    expect((await hostRevoke(jsonRequest(route, { generation: 2 }, { ...headers, origin: "https://evil.example.test" }), context)).status).toBe(403);
    expect((await hostRevoke(jsonRequest(route, { generation: 1.5 }), context)).status).toBe(400);
    mocks.repository.revokeLinkInvitation.mockRejectedValueOnce(new StoreConflictError("stale"));
    expect((await hostRevoke(jsonRequest(route, { generation: 1 }), context)).status).toBe(409);
    mocks.repository.revokeLinkInvitation.mockRejectedValueOnce(new StoreAccessDeniedError());
    expect((await hostRevoke(jsonRequest(route, { generation: 2 }), context)).status).toBe(404);
    expect(mocks.repository.revokeLinkInvitation).toHaveBeenCalledWith({ nihoUserId: "owner-secret" }, id, 2);
  });
});
