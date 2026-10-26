import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The http-mode login, refresh and relay routes against a synthetic NIHO API. */
const state = vi.hoisted(() => ({
  config: {
    apiMode: "http",
    hostConsoleEnabled: true,
    hostSessionSecret: "synthetic-route-test-secret-0123456789abcdef",
    nihoFirebaseWebApiKey: "",
    nihoWebOrigin: "https://niho.example.test",
    siteUrl: "https://experience.example.test",
  },
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: state.config, isPreview: false }));

import { GET as login } from "@/app/(host)/host/auth/login/route";
import { GET as callback } from "@/app/(host)/host/auth/callback/route";
import { POST as refresh } from "@/app/(host)/host/auth/refresh/route";
import { POST as logout } from "@/app/(host)/host/auth/logout/route";
import { GET as relayGet, POST as relayPost } from "@/app/(host)/host/api/[...path]/route";
import { cookieSealer } from "./cookie-seal";
import { decodeSession, encodeSession, LOGIN_COOKIE, SESSION_COOKIE, startSession } from "./session";

const SITE = state.config.siteUrl;
const NIHO = state.config.nihoWebOrigin;
const MIN = 60 * 1000;
const sameOrigin = { origin: SITE, "sec-fetch-site": "same-origin" };

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;
let handler: Handler;
const calls: { url: URL; init: RequestInit }[] = [];

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    return handler(url, init);
  }));
});
afterEach(() => vi.unstubAllGlobals());

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function setCookies(response: Response): Map<string, { value: string; attributes: string }> {
  const cookies = new Map<string, { value: string; attributes: string }>();
  for (const header of response.headers.getSetCookie()) {
    const [pair = "", ...attributes] = header.split("; ");
    const index = pair.indexOf("=");
    cookies.set(pair.slice(0, index), { value: pair.slice(index + 1), attributes: attributes.join("; ") });
  }
  return cookies;
}

function sessionCookie(idTokenExpiresIn: number) {
  const now = Date.now();
  const session = startSession({ refreshToken: "refresh-1", idToken: "id-1", idTokenExpiresAt: now + idTokenExpiresIn, connectionId: "conn_1", connectionExpiresAt: now + 90 * 24 * 60 * MIN, displayName: "合成 ホスト", iconUrl: null }, now);
  return `${SESSION_COOKIE}=${encodeSession(cookieSealer(state.config.hostSessionSecret, "session"), session)}`;
}

function openSession(value: string | undefined) {
  return decodeSession(cookieSealer(state.config.hostSessionSecret, "session"), value, Date.now());
}

async function startLogin(query = "") {
  const response = login(new NextRequest(`${SITE}/host/auth/login${query}`));
  const location = new URL(response.headers.get("location")!);
  const cookie = setCookies(response).get(LOGIN_COOKIE)!;
  return { response, location, cookie: `${LOGIN_COOKIE}=${cookie.value}`, attributes: cookie.attributes };
}

describe("login and callback (http mode)", () => {
  it("sends the host to NIHO with a S256 challenge and keeps the verifier in a sealed 10-minute cookie", async () => {
    const { response, location, cookie, attributes } = await startLogin("?providerId=p_1&next=https://evil.example.test");
    expect(response.status).toBe(303);
    expect(location.origin + location.pathname).toBe(`${NIHO}/connect/niho-experience`);
    expect(location.searchParams.get("v")).toBe("1");
    expect(location.searchParams.get("challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(location.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(location.searchParams.get("origin")).toBe(SITE);
    expect([...location.searchParams.keys()].sort()).toEqual(["challenge", "origin", "state", "v"]);
    expect(attributes).toMatch(/Path=\/host\/auth/);
    expect(attributes).toMatch(/Max-Age=600/);
    expect(attributes).toMatch(/Secure/);
    expect(attributes).toMatch(/HttpOnly/);
    expect(attributes).toMatch(/SameSite=lax/i);
    expect(cookie).not.toContain(location.searchParams.get("state")!);
  });

  it("exchanges the code for an API-only token and opens the requested provider", async () => {
    const { location, cookie } = await startLogin("?providerId=p_1");
    handler = (url, init) => {
      if (url.pathname === "/api/auth/app-connect/exchange") {
        const body = JSON.parse(String(init.body));
        expect(body).toMatchObject({ clientId: "niho-experience", code: "code-1" });
        expect(body.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
        return json(200, { accessToken: "api-only-1", expiresAt: new Date(Date.now() + 60 * MIN).toISOString(), refreshToken: "refresh-1", connectionId: "conn_1", connectionExpiresAt: new Date(Date.now() + 90 * 24 * 60 * MIN).toISOString(), user: { displayName: "合成 ホスト", iconImage: null } });
      }
      throw new Error(`unexpected ${url.href}`);
    };
    const state = location.searchParams.get("state")!;
    const response = await callback(new NextRequest(`${SITE}/host/auth/callback?code=code-1&state=${state}`, { headers: { cookie } }));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/host/home?providerId=p_1");
    const cookies = setCookies(response);
    expect(cookies.get(LOGIN_COOKIE)?.attributes).toMatch(/Max-Age=0/);
    const session = cookies.get(SESSION_COOKIE)!;
    expect(session.attributes).toMatch(/Path=\/host;/);
    expect(session.attributes).toMatch(/Max-Age=2592000/);
    expect(session.value).not.toContain("api-only-1");
    expect(openSession(session.value)).toMatchObject({ refreshToken: "refresh-1", idToken: "api-only-1", connectionId: "conn_1", displayName: "合成 ホスト" });
    expect(calls).toHaveLength(1);
  });

  it("keeps only a validated preparation case in sealed login state and returns to its fixed page", async () => {
    const { location, cookie } = await startLogin("?preparationCaseId=case_19404&returnTo=https://evil.example.test");
    expect(location.searchParams.has("preparationCaseId")).toBe(false);
    expect(location.searchParams.has("returnTo")).toBe(false);
    handler = (url, init) => {
      if (url.pathname === "/api/auth/app-connect/exchange") return json(200, { accessToken: "api-only-1", expiresAt: new Date(Date.now() + 60 * MIN).toISOString(), refreshToken: "refresh-1", connectionId: "conn_1", connectionExpiresAt: new Date(Date.now() + 90 * 24 * 60 * MIN).toISOString(), user: { displayName: "合成 ホスト", iconImage: null } });
      throw new Error(`unexpected ${url.href} ${String(init.method)}`);
    };
    const response = await callback(new NextRequest(`${SITE}/host/auth/callback?code=code-1&state=${location.searchParams.get("state")}`, { headers: { cookie } }));
    expect(response.headers.get("location")).toBe("/host/preparations/case_19404");

    const unsafe = await startLogin("?preparationCaseId=..%2Fadmin&returnTo=%2Fadmin");
    handler = (url) => url.pathname === "/api/auth/app-connect/exchange"
      ? json(200, { accessToken: "api-only-2", expiresAt: new Date(Date.now() + 60 * MIN).toISOString(), refreshToken: "refresh-2", connectionId: "conn_2", connectionExpiresAt: new Date(Date.now() + 90 * 24 * 60 * MIN).toISOString(), user: { displayName: "合成 ホスト", iconImage: null } })
      : json(503, {});
    const unsafeResponse = await callback(new NextRequest(`${SITE}/host/auth/callback?code=code-2&state=${unsafe.location.searchParams.get("state")}`, { headers: { cookie: unsafe.cookie } }));
    expect(unsafeResponse.headers.get("location")).toBe("/host/home");
  });

  it("stops before calling NIHO when the state does not match or the login cookie is missing", async () => {
    const { cookie } = await startLogin();
    const wrong = await callback(new NextRequest(`${SITE}/host/auth/callback?code=c&state=${"x".repeat(43)}`, { headers: { cookie } }));
    expect(wrong.headers.get("location")).toBe("/host/auth/error?reason=state");
    const missing = await callback(new NextRequest(`${SITE}/host/auth/callback?code=c&state=${"x".repeat(43)}`));
    expect(missing.headers.get("location")).toBe("/host/auth/error?reason=expired");
    expect(calls).toHaveLength(0);
  });

  it("separates a cancelled login, a refused code and an outage", async () => {
    const first = await startLogin();
    const denied = await callback(new NextRequest(`${SITE}/host/auth/callback?error=access_denied&state=${first.location.searchParams.get("state")}`, { headers: { cookie: first.cookie } }));
    expect(denied.headers.get("location")).toBe("/host/auth/error?reason=denied");

    handler = () => json(400, { error: "invalid_code" });
    const second = await startLogin();
    const rejected = await callback(new NextRequest(`${SITE}/host/auth/callback?code=c&state=${second.location.searchParams.get("state")}`, { headers: { cookie: second.cookie } }));
    expect(rejected.headers.get("location")).toBe("/host/auth/error?reason=rejected");

    handler = () => json(502, {});
    const third = await startLogin();
    const down = await callback(new NextRequest(`${SITE}/host/auth/callback?code=c&state=${third.location.searchParams.get("state")}`, { headers: { cookie: third.cookie } }));
    expect(down.headers.get("location")).toBe("/host/auth/error?reason=unavailable");
    expect(setCookies(down).has(SESSION_COOKIE)).toBe(false);
  });

  it("has no mock login in http mode", async () => {
    const { GET } = await import("@/app/(host)/host/auth/mock-login/route");
    expect((await GET(new NextRequest(`${SITE}/host/auth/mock-login`))).status).toBe(404);
  });
});

describe("refresh (http mode)", () => {
  const post = (cookie: string, headers: Record<string, string> = sameOrigin) => refresh(new NextRequest(`${SITE}/host/auth/refresh`, { method: "POST", headers: { ...headers, cookie } }));

  it("does nothing while the ID token has more than five minutes left", async () => {
    const response = await post(sessionCookie(30 * MIN));
    expect(await response.json()).toMatchObject({ refreshed: false });
    expect(calls).toHaveLength(0);
  });

  it("rotates the refresh token and stores the new API bearer", async () => {
    handler = (url) => url.pathname === "/api/auth/app-connect/refresh"
      ? json(200, { accessToken: "api-only-2", expiresAt: new Date(Date.now() + 60 * MIN).toISOString(), refreshToken: "refresh-2", connectionExpiresAt: new Date(Date.now() + 90 * 24 * 60 * MIN).toISOString() })
      : json(503, {});
    const response = await post(sessionCookie(4 * MIN));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ refreshed: true });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ clientId: "niho-experience", refreshToken: "refresh-1" });
    expect(openSession(setCookies(response).get(SESSION_COOKIE)?.value)).toMatchObject({ refreshToken: "refresh-2", idToken: "api-only-2" });
    expect(calls).toHaveLength(1);
  });

  it("reports a malformed NIHO refresh response without calling Firebase", async () => {
    handler = (url) => url.pathname === "/api/auth/app-connect/refresh"
      ? json(200, { customToken: "legacy-custom", refreshToken: "refresh-2", connectionExpiresAt: new Date(Date.now() + 90 * 24 * 60 * MIN).toISOString() })
      : json(503, {});
    const response = await post(sessionCookie(4 * MIN));
    expect(response.status).toBe(503);
    expect(openSession(setCookies(response).get(SESSION_COOKIE)?.value)).toMatchObject({ refreshToken: "refresh-1", idToken: "id-1" });
    expect(calls).toHaveLength(1);
  });

  it("signs out when NIHO has ended the connection", async () => {
    handler = () => json(401, { error: "connection_revoked" });
    const response = await post(sessionCookie(4 * MIN));
    expect(response.status).toBe(401);
    expect(setCookies(response).get(SESSION_COOKIE)?.attributes).toMatch(/Max-Age=0/);
  });

  it("refuses cross-site calls", async () => {
    expect((await post(sessionCookie(4 * MIN), { origin: "https://evil.example.test", "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect(calls).toHaveLength(0);
  });
});

describe("API relay (http mode)", () => {
  const context = (...path: string[]) => ({ params: Promise.resolve({ path }) });

  it("forwards allowed calls with the Bearer token and without browser cookies", async () => {
    handler = () => json(200, { providers: [] });
    const response = await relayGet(new NextRequest(`${SITE}/host/api/experience-providers?status=x`, { headers: { cookie: sessionCookie(30 * MIN), accept: "application/json" } }), context("experience-providers"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(calls[0]!.url.href).toBe(`${NIHO}/api/experience-providers?status=x`);
    const sent = new Headers(calls[0]!.init.headers);
    expect(sent.get("authorization")).toBe("Bearer id-1");
    expect(sent.get("cookie")).toBeNull();
  });

  it("asks the browser to refresh instead of calling NIHO with an expiring token", async () => {
    const response = await relayGet(new NextRequest(`${SITE}/host/api/auth/me`, { headers: { cookie: sessionCookie(30 * 1000) } }), context("auth", "me"));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "session_refresh_required" });
    expect(calls).toHaveLength(0);
  });

  it("answers 404 for other NIHO paths and 403 for cross-site changes", async () => {
    const cookie = sessionCookie(30 * MIN);
    expect((await relayGet(new NextRequest(`${SITE}/host/api/users`, { headers: { cookie } }), context("users"))).status).toBe(404);
    expect((await relayPost(new NextRequest(`${SITE}/host/api/experience-providers`, { method: "POST", headers: { cookie, origin: SITE, "sec-fetch-site": "same-site" }, body: "{}" }), context("experience-providers"))).status).toBe(403);
    expect(calls).toHaveLength(0);
  });
});

describe("logout (http mode)", () => {
  it("ends the NIHO connection and clears the cookie, even when NIHO fails", async () => {
    handler = () => json(500, {});
    const response = await logout(new NextRequest(`${SITE}/host/auth/logout`, { method: "POST", headers: { ...sameOrigin, cookie: sessionCookie(30 * MIN) } }));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/host");
    expect(calls[0]!.url.href).toBe(`${NIHO}/api/auth/app-connections/conn_1?reason=logout`);
    expect(calls[0]!.init.method).toBe("DELETE");
    expect(setCookies(response).get(SESSION_COOKIE)?.attributes).toMatch(/Max-Age=0/);
  });
});
