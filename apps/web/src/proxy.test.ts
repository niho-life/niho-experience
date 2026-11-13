import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * 運営の CLI (#576, docs/operator-cli.md): a Bearer Google ID token on /admin/api becomes the admin's session through
 * src/proxy.ts and the same route handlers the Admin screens use. Google (verifyIdToken) and the stores are stubbed; no
 * network; synthetic accounts only.
 */

const SUBJECT = "100000000000000000001";
const AUDIENCE = "32555940559.apps.googleusercontent.com";
const SITE = "https://experience.example.test";
const API = `${SITE}/admin/api/product-classifications`;

const state = vi.hoisted(() => ({
  config: {
    apiMode: "http",
    adminSupportConsoleEnabled: true,
    adminGoogleLoginEnabled: true,
    adminAllowedEmails: ["admin.sample@niho.life"] as readonly string[],
    operatorCliEnabled: true,
    operatorCliAudiences: ["32555940559.apps.googleusercontent.com"] as readonly string[],
    adminSessionSecret: "synthetic-admin-route-secret-0123456789abcdef",
    adminOrigin: "https://experience.example.test",
    siteUrl: "https://experience.example.test",
  },
  payload: undefined as Record<string, unknown> | undefined,
  verifyError: null as Error | null,
  requests: { record: vi.fn() },
  repository: { adminList: vi.fn(), adminRead: vi.fn(), adminSave: vi.fn() },
  incoming: new Headers(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: state.config, isPreview: false }));
vi.mock("google-auth-library", () => ({
  OAuth2Client: class {
    async verifyIdToken() {
      if (state.verifyError) throw state.verifyError;
      return { getPayload: () => state.payload };
    }
  },
}));
vi.mock("next/headers", () => ({ headers: async () => state.incoming, cookies: async () => ({ get: () => undefined }) }));
vi.mock("@/lib/experience/store-server", () => ({
  adminSessions: () => null,
  operatorCliRequests: () => state.requests,
  productClassificationRepository: () => state.repository,
}));

import { PUT, GET } from "@/app/(admin)/admin/api/product-classifications/route";
import { adminMutationAllowed } from "@/lib/admin/server";
import { OPERATOR_ASSERTION_HEADER, operatorApiAllowed, operatorIdentity } from "@/lib/admin/operator-cli";
import { adminActorIdForGoogleSubject } from "@niho-experience/experience-store";
import { proxy } from "./proxy";

const TOKEN = `${"a".repeat(20)}.${"b".repeat(20)}.${"c".repeat(20)}`;
const goodPayload = () => ({ iss: "https://accounts.google.com", aud: AUDIENCE, sub: SUBJECT, email: "Admin.Sample@niho.life", email_verified: true, hd: "niho.life", exp: Math.floor(Date.now() / 1000) + 3600 });
const ACTOR = adminActorIdForGoogleSubject(SUBJECT);
const body = { items: [{ providerId: "p1", productId: "x1", classification: { category: "walk", area: "kita", companions: ["solo"], occasions: [] } }] };

function cli(path: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) {
  return new NextRequest(`${SITE}${path}`, {
    method: init.method ?? "GET",
    headers: { authorization: `Bearer ${TOKEN}`, "x-niho-operator-ai": "claude-code", ...(init.method && init.method !== "GET" ? { "x-niho-operation-id": "op-20261114-0001", "content-type": "application/json" } : {}), ...init.headers },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

/** What the route handler would see after the proxy: the response's request-header overrides applied to the request. */
function forwarded(request: NextRequest, response: Response): Request {
  const headers = new Headers(request.headers);
  const overridden = (response.headers.get("x-middleware-override-headers") ?? "").split(",").filter(Boolean);
  for (const name of [...headers.keys()]) if (!overridden.includes(name)) headers.delete(name);
  for (const name of overridden) headers.set(name, response.headers.get(`x-middleware-request-${name}`) ?? "");
  state.incoming = headers;
  return new Request(request.url, { method: request.method, headers, body: request.method === "GET" ? undefined : JSON.stringify(body) });
}

beforeEach(() => {
  vi.clearAllMocks();
  state.config.operatorCliEnabled = true;
  state.config.adminAllowedEmails = ["admin.sample@niho.life"];
  state.payload = goodPayload();
  state.verifyError = null;
  state.requests.record.mockResolvedValue({ status: "recorded", requestRef: "r" });
  state.incoming = new Headers();
});

describe("operatorIdentity", () => {
  const expected = { audiences: [AUDIENCE], now: Date.now() };
  it("accepts a verified niho.life account of an accepted client and lower-cases the address", () => {
    expect(operatorIdentity(goodPayload() as never, expected)).toEqual({ sub: SUBJECT, email: "admin.sample@niho.life" });
  });
  it("refuses another client, issuer, domain, an unverified address, an expired token and a missing subject", () => {
    const bad: Array<Record<string, unknown>> = [
      { aud: "other.apps.googleusercontent.com" }, { iss: "https://evil.example" }, { hd: undefined }, { hd: "example.com" },
      { email: "admin.sample@example.com" }, { email_verified: false }, { exp: Math.floor(Date.now() / 1000) - 1 }, { sub: "" },
    ];
    for (const patch of bad) expect(operatorIdentity({ ...goodPayload(), ...patch } as never, expected), JSON.stringify(patch)).toBeNull();
    expect(operatorIdentity(undefined, expected)).toBeNull();
  });
  it("opens only the areas the CLI is meant for, never a refund, a payout or an account", () => {
    expect(operatorApiAllowed("/admin/api/product-classifications")).toBe(true);
    expect(operatorApiAllowed("/admin/api/people")).toBe(true);
    for (const path of ["/admin/api/refunds", "/admin/api/payouts", "/admin/api/bookings/x/cancel", "/admin/api/people-x", "/admin/auth/logout", "/admin/api/"]) expect(operatorApiAllowed(path), path).toBe(false);
  });
});

describe("proxy (運営の CLI)", () => {
  it("passes a request without a Bearer token on, dropping an assertion a client sent", async () => {
    const request = new NextRequest(API, { headers: { [OPERATOR_ASSERTION_HEADER]: "forged", cookie: "a=b" } });
    const response = await proxy(request);
    expect(response.status).toBe(200);
    const overridden = (response.headers.get("x-middleware-override-headers") ?? "").split(",");
    expect(overridden).not.toContain(OPERATOR_ASSERTION_HEADER);
    expect(overridden).toContain("cookie");
  });

  it("does nothing with a Bearer token while the flag is off", async () => {
    state.config.operatorCliEnabled = false;
    const request = cli("/admin/api/product-classifications");
    const response = await proxy(request);
    expect(response.status).toBe(200);
    expect(state.requests.record).not.toHaveBeenCalled();
    expect(response.headers.get(`x-middleware-request-${OPERATOR_ASSERTION_HEADER}`)).toBeNull();
  });

  it("refuses areas outside the CLI's list, a bad token, an address off the allowlist, a Google outage and a malformed call", async () => {
    expect((await proxy(cli("/admin/api/refunds"))).status).toBe(403);
    expect(await (await proxy(cli("/admin/api/refunds"))).json()).toEqual({ error: "not_available_from_cli" });
    state.verifyError = new Error("bad signature");
    expect((await proxy(cli("/admin/api/people"))).status).toBe(401);
    state.verifyError = Object.assign(new Error("fetch failed"), { code: "ECONNRESET" });
    expect([401, 503]).toContain((await proxy(cli("/admin/api/people"))).status);
    state.verifyError = null;
    state.payload = { ...goodPayload(), aud: "other.apps.googleusercontent.com" };
    expect((await proxy(cli("/admin/api/people"))).status).toBe(401);
    state.payload = goodPayload();
    state.config.adminAllowedEmails = ["someone.else@niho.life"];
    expect((await proxy(cli("/admin/api/people"))).status).toBe(403);
    state.config.adminAllowedEmails = ["admin.sample@niho.life"];
    expect((await proxy(cli("/admin/api/people", { headers: { "x-niho-operator-ai": "gpt" } }))).status).toBe(400);
    expect((await proxy(new NextRequest(`${SITE}/admin/api/people`, { method: "PUT", headers: { authorization: `Bearer ${TOKEN}`, "x-niho-operator-ai": "codex" }, body: "{}" }))).status).toBe(400);
    expect((await proxy(cli("/admin/api/people", { method: "DELETE", headers: { "x-niho-operation-id": "short" } }))).status).toBe(400);
    expect((await proxy(new NextRequest(`${SITE}/admin/api/people`, { method: "OPTIONS", headers: { authorization: `Bearer ${TOKEN}` } }))).status).toBe(405);
    expect(state.requests.record).not.toHaveBeenCalled();
  });

  it("reads as the admin through the same route handler, without recording a read", async () => {
    state.repository.adminList.mockResolvedValue([]);
    const request = cli("/admin/api/product-classifications");
    const response = await proxy(request);
    expect(response.status).toBe(200);
    const result = await GET(forwarded(request, response));
    expect(result.status).toBe(200);
    expect(state.repository.adminList).toHaveBeenCalledWith({ nihoUserId: ACTOR });
    expect(state.requests.record).not.toHaveBeenCalled();
  });

  it("records a write (admin, AI, operation, path, body hash) before it runs, and the route saves as that admin", async () => {
    state.repository.adminSave.mockResolvedValue(1);
    const request = cli("/admin/api/product-classifications", { method: "PUT", body });
    const response = await proxy(request);
    expect(response.status).toBe(200);
    expect(state.requests.record).toHaveBeenCalledWith(expect.objectContaining({
      adminActorId: ACTOR, operationId: "op-20261114-0001", aiKind: "claude-code", method: "PUT", path: "/admin/api/product-classifications",
      bodySha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    }));
    const incoming = forwarded(request, response);
    expect(incoming.headers.get("authorization")).toBeNull();
    expect(adminMutationAllowed(incoming)).toBe(true);
    const result = await PUT(incoming);
    expect(result.status).toBe(200);
    expect(state.repository.adminSave).toHaveBeenCalledWith({ nihoUserId: ACTOR }, body.items);
  });

  it("refuses the same operation ID a second time and never reaches the route", async () => {
    state.requests.record.mockResolvedValue({ status: "duplicate", requestRef: "r" });
    const response = await proxy(cli("/admin/api/product-classifications", { method: "PUT", body }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "operation_already_recorded" });
  });

  it("refuses a write it cannot record, and a body over the limit", async () => {
    state.requests.record.mockRejectedValue(new Error("db down"));
    expect((await proxy(cli("/admin/api/product-classifications", { method: "PUT", body }))).status).toBe(503);
    state.requests.record.mockClear();
    const big = cli("/admin/api/product-classifications", { method: "PUT", headers: { "content-length": String(2 * 1024 * 1024) }, body });
    expect((await proxy(big)).status).toBe(413);
    expect(state.requests.record).not.toHaveBeenCalled();
  });

  it("allows a change only with an assertion for that exact method and path, and refuses a forged or replayed one", async () => {
    const request = cli("/admin/api/product-classifications", { method: "PUT", body });
    const response = await proxy(request);
    const sealed = response.headers.get(`x-middleware-request-${OPERATOR_ASSERTION_HEADER}`)!;
    const same = (path: string, method: string, header: string | null) => new Request(`${SITE}${path}`, { method, headers: header ? { [OPERATOR_ASSERTION_HEADER]: header } : {} });
    expect(adminMutationAllowed(same("/admin/api/product-classifications", "PUT", sealed))).toBe(true);
    expect(adminMutationAllowed(same("/admin/api/people", "PUT", sealed))).toBe(false);
    expect(adminMutationAllowed(same("/admin/api/product-classifications", "DELETE", sealed))).toBe(false);
    expect(adminMutationAllowed(same("/admin/api/product-classifications", "PUT", `${sealed.slice(0, 30)}${sealed[30] === "A" ? "B" : "A"}${sealed.slice(31)}`))).toBe(false);
    expect(adminMutationAllowed(same("/admin/api/product-classifications", "PUT", "forged"))).toBe(false);
    // A read's assertion carries no operation ID, so it never opens a change.
    const read = await proxy(cli("/admin/api/product-classifications"));
    const readSealed = read.headers.get(`x-middleware-request-${OPERATOR_ASSERTION_HEADER}`)!;
    expect(adminMutationAllowed(same("/admin/api/product-classifications", "PUT", readSealed))).toBe(false);
    // Without any assertion it is the cookie flow's same-origin check, which a command line cannot pass.
    expect(adminMutationAllowed(same("/admin/api/product-classifications", "PUT", null))).toBe(false);
  });
});
