import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CookieSealer } from "@/lib/host/cookie-seal";

const mocks = vi.hoisted(() => ({
  csrf: true, prepare: vi.fn(), accept: vi.fn(), session: null as Record<string, unknown> | null, providers: { status: "ok", providers: [] } as Record<string, unknown>,
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: { hostConsoleEnabled: true, apiMode: "http", hostSessionSecret: "synthetic-invitation-secret-0123456789abcdef", siteUrl: "https://experience.example" } }));
vi.mock("@/lib/host/relay", () => ({ mutationFromSameOrigin: () => mocks.csrf }));
vi.mock("@/lib/experience/store-server", () => ({ productOperatorRepository: () => ({ prepare: mocks.prepare, accept: mocks.accept }) }));
vi.mock("@/lib/host/server", async () => {
  const { NextResponse } = await import("next/server");
  return {
    hostNotFound: () => NextResponse.json({ error: "not_found" }, { status: 404 }),
    noStoreJson: (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "cache-control": "private, no-store" } }),
    siteOrigin: () => "https://experience.example", readHostSession: async () => mocks.session,
    loadHostProviders: async () => mocks.providers,
  };
});

import { POST as prepare } from "./[invitationId]/prepare/route";
import { POST as accept } from "./[invitationId]/accept/route";

const ID = "00000000-0000-4000-8000-000000000196";
const TOKEN = "a".repeat(43);
const context = { params: Promise.resolve({ invitationId: ID }) };
const request = (path: string, body: unknown, cookie?: string) => new NextRequest(`https://experience.example${path}`, {
  method: "POST", headers: { origin: "https://experience.example", "sec-fetch-site": "same-origin", "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body),
});

beforeEach(() => {
  vi.clearAllMocks(); mocks.csrf = true; mocks.session = null; mocks.providers = { status: "ok", providers: [] };
  mocks.prepare.mockResolvedValue({ invitationId: ID, expiresAtUtc: new Date(Date.now() + 3600_000).toISOString() });
  mocks.accept.mockResolvedValue({ providerId: "provider-a", active: true });
});

describe("product operator invitation HTTP boundary", () => {
  it.each(["prepare", "accept"] as const)("cancels an oversized chunked %s body before consuming it", async (action) => {
    let pulled = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { if (++pulled < 10) controller.enqueue(new Uint8Array(1024).fill(97)); else controller.close(); },
      cancel() { cancelled = true; },
    });
    const init = {
      method: "POST", duplex: "half" as const, body: stream,
      headers: { "content-type": "application/json", origin: "https://experience.example" },
    };
    const response = await (action === "prepare" ? prepare : accept)(new NextRequest(`https://experience.example/host/invitations/${ID}/${action}`, init), context);
    expect(response.status).toBe(413);
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(10);
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.accept).not.toHaveBeenCalled();
  });

  it("requires same-origin and a canonical 32-byte base64url token", async () => {
    mocks.csrf = false;
    expect((await prepare(request(`/host/invitations/${ID}/prepare`, { token: TOKEN }), context)).status).toBe(403);
    mocks.csrf = true;
    expect((await prepare(request(`/host/invitations/${ID}/prepare`, { token: "short" }), context)).status).toBe(400);
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it("moves the fragment token into a short purpose-separated HttpOnly cookie without returning it", async () => {
    const response = await prepare(request(`/host/invitations/${ID}/prepare`, { token: TOKEN }), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ prepared: true });
    expect(response.headers.get("set-cookie")).toMatch(/__Secure-niho_operator_invitation=/);
    expect(response.headers.get("set-cookie")).toMatch(/HttpOnly/i);
    expect(response.headers.get("set-cookie")).toMatch(/Secure/i);
    expect(response.headers.get("set-cookie")).toMatch(/SameSite=lax/i);
    expect(response.headers.get("set-cookie")).toMatch(/Path=\/host/);
    expect(JSON.stringify([...response.headers])).not.toContain(TOKEN);
    const raw = response.cookies.get("__Secure-niho_operator_invitation")?.value;
    expect(new CookieSealer(["synthetic-invitation-secret-0123456789abcdef"], "session").open(raw)).toBeNull();
  });

  it("requires a current NIHO identity, accepts with an empty provider list, and returns only a fixed calendar path", async () => {
    const prepared = await prepare(request(`/host/invitations/${ID}/prepare`, { token: TOKEN }), context);
    const cookie = `__Secure-niho_operator_invitation=${prepared.cookies.get("__Secure-niho_operator_invitation")?.value}`;
    expect((await accept(request(`/host/invitations/${ID}/accept`, {}, cookie), context)).status).toBe(401);
    mocks.session = { nihoUserId: "operator-a", idTokenExpiresAt: Date.now() + 3600_000 };
    const response = await accept(request(`/host/invitations/${ID}/accept`, {}, cookie), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ href: "/host/calendar?providerId=provider-a" });
    expect(mocks.accept).toHaveBeenCalledWith(ID, TOKEN, "operator-a");
    expect(response.headers.get("set-cookie")).toMatch(/Max-Age=0/);
  });

  it("rejects an expired or wrong-purpose invitation session", async () => {
    mocks.session = { nihoUserId: "operator-a", idTokenExpiresAt: Date.now() + 3600_000 };
    const sessionValue = new CookieSealer(["synthetic-invitation-secret-0123456789abcdef"], "session").seal({ invitationId: ID, token: TOKEN, expiresAt: Date.now() + 60_000 });
    expect((await accept(request(`/host/invitations/${ID}/accept`, {}, `__Secure-niho_operator_invitation=${sessionValue}`), context)).status).toBe(403);
    const expired = new CookieSealer(["synthetic-invitation-secret-0123456789abcdef"], "product-operator-invitation")
      .seal({ v: 1, i: ID, t: TOKEN, x: Date.now() - 1 });
    expect((await accept(request(`/host/invitations/${ID}/accept`, {}, `__Secure-niho_operator_invitation=${expired}`), context)).status).toBe(403);
    expect(mocks.accept).not.toHaveBeenCalled();
  });
});
