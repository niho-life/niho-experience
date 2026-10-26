import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  config: {
    apiMode: "http",
    adminSupportConsoleEnabled: true,
    hostConsoleEnabled: false,
    hostSessionSecret: "",
    adminSessionSecret: "synthetic-admin-route-secret-0123456789abcdef",
    adminOrigin: "https://experience.example.test",
    nihoFirebaseWebApiKey: "synthetic-firebase-key",
    nihoWebOrigin: "https://niho.example.test",
    siteUrl: "https://experience.example.test",
  },
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: state.config, isPreview: false }));

import { GET as login } from "@/app/(admin)/admin/auth/login/route";
import { GET as callback } from "@/app/(admin)/admin/auth/callback/route";
import { POST as refresh } from "@/app/(admin)/admin/auth/refresh/route";
import { POST as logout } from "@/app/(admin)/admin/auth/logout/route";
import { CookieSealer } from "@/lib/host/cookie-seal";
import { encodeSession, startSession } from "@/lib/host/session";
import { encodeAdminSession, startAdminSession } from "@/admin/session";
import {
  ADMIN_HTTP_LOGIN_COOKIE,
  ADMIN_HTTP_SESSION_COOKIE,
  decodeAdminHttpLogin,
  decodeAdminHttpSession,
  encodeAdminHttpSession,
  startAdminHttpSession,
} from "./http-session";
import { safeAdminReturnTo } from "./routes";

const SITE = state.config.siteUrl;
const NIHO = state.config.nihoWebOrigin;
const HOUR = 60 * 60 * 1000;
const sameOrigin = { origin: SITE, "sec-fetch-site": "same-origin" };

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;
let handler: Handler;
const calls: Array<{ url: URL; init: RequestInit }> = [];

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
  const result = new Map<string, { value: string; attributes: string }>();
  for (const header of response.headers.getSetCookie()) {
    const [pair = "", ...attributes] = header.split("; ");
    const index = pair.indexOf("=");
    result.set(pair.slice(0, index), { value: pair.slice(index + 1), attributes: attributes.join("; ") });
  }
  return result;
}

function httpSession(idTokenExpiresIn = HOUR) {
  const now = Date.now();
  return startAdminHttpSession({
    refreshToken: "refresh-1",
    idToken: "id-1",
    idTokenExpiresAt: now + idTokenExpiresIn,
    connectionId: "connection-1",
    exchangedConnectionExpiresAt: now + 8 * HOUR,
    verifiedConnectionExpiresAt: now + 8 * HOUR,
    actorId: "admin-1",
    actorName: "Admin One",
  }, now)!;
}

function sessionCookie(session = httpSession()) {
  const value = encodeAdminHttpSession(new CookieSealer([state.config.adminSessionSecret], "admin-http-session"), session);
  return `${ADMIN_HTTP_SESSION_COOKIE}=${value}`;
}

async function startLogin(query = "") {
  const response = login(new NextRequest(`${SITE}/admin/auth/login${query}`));
  const location = new URL(response.headers.get("location")!);
  const cookie = setCookies(response).get(ADMIN_HTTP_LOGIN_COOKIE)!;
  return { response, location, cookie: `${ADMIN_HTTP_LOGIN_COOKIE}=${cookie.value}`, rawCookie: cookie };
}

function successfulAuth(connectionExpiresAt: number) {
  handler = (url, init) => {
    if (url.pathname === "/api/auth/app-connect/exchange") {
      expect(JSON.parse(String(init.body))).toMatchObject({ clientId: "niho-experience-admin", code: "c".repeat(43) });
      return json(200, {
        customToken: "custom-1",
        refreshToken: "refresh-1",
        connectionId: "connection-1",
        connectionExpiresAt: new Date(connectionExpiresAt).toISOString(),
        user: { id: "ignored", displayName: null, handle: null, iconImage: null },
      });
    }
    if (url.hostname === "identitytoolkit.googleapis.com") return json(200, { idToken: "id-1", expiresIn: "3600", refreshToken: "firebase-token-must-not-be-kept" });
    if (url.pathname === "/api/auth/app-connect/experience-admin/session") {
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer id-1");
      return json(200, {
        actor: { id: "admin-1", displayName: "Admin One" },
        connection: { id: "connection-1", expiresAt: new Date(connectionExpiresAt).toISOString() },
      });
    }
    throw new Error(`unexpected ${url.href}`);
  };
}

describe("Admin HTTP login and callback", () => {
  it("allows only the two fixed console destinations", () => {
    expect(safeAdminReturnTo("/admin/bookings")).toBe("/admin/bookings");
    expect(safeAdminReturnTo("/admin/notifications")).toBe("/admin/notifications");
    expect(safeAdminReturnTo("/admin/notifications?next=https://evil.example.test")).toBe("/admin/bookings");
  });

  it("uses the dedicated client with PKCE/state/origin and a short isolated login cookie", async () => {
    const { location, rawCookie } = await startLogin("?returnTo=https://evil.example.test");
    expect(location.origin + location.pathname).toBe(`${NIHO}/connect/niho-experience-admin`);
    expect(location.searchParams.get("challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(location.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(location.searchParams.get("origin")).toBe(SITE);
    expect(rawCookie.attributes).toMatch(/Path=\/admin\/auth/);
    expect(rawCookie.attributes).toMatch(/Max-Age=600/);
    expect(rawCookie.attributes).toMatch(/HttpOnly/);
    expect(rawCookie.attributes).toMatch(/Secure/);
    const loginState = decodeAdminHttpLogin(new CookieSealer([state.config.adminSessionSecret], "admin-http-login"), rawCookie.value, Date.now());
    expect(loginState?.returnTo).toBe("/admin/bookings");
  });

  it("verifies the dedicated session before sealing tokens and redirects without a query", async () => {
    const expiresAt = Date.now() + 8 * HOUR;
    successfulAuth(expiresAt);
    const { location, cookie } = await startLogin();
    const response = await callback(new NextRequest(`${SITE}/admin/auth/callback?code=${"c".repeat(43)}&state=${location.searchParams.get("state")}`, { headers: { cookie } }));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/admin/bookings");
    expect(response.headers.get("location")).not.toContain("?");
    const cookies = setCookies(response);
    expect(cookies.get(ADMIN_HTTP_LOGIN_COOKIE)?.attributes).toMatch(/Max-Age=0/);
    const sealed = cookies.get(ADMIN_HTTP_SESSION_COOKIE)!;
    expect(sealed.attributes).toMatch(/Path=\/admin;/);
    expect(sealed.value).not.toMatch(/refresh-1|id-1|Admin One/);
    const session = decodeAdminHttpSession(new CookieSealer([state.config.adminSessionSecret], "admin-http-session"), sealed.value, Date.now());
    expect(session).toMatchObject({ connectionId: "connection-1", actorId: "admin-1", actorName: "Admin One" });
    expect(JSON.stringify(session)).not.toContain("firebase-token-must-not-be-kept");
  });

  it("rejects wrong state, missing/replayed login state, and a non-Admin verification", async () => {
    const first = await startLogin();
    const wrong = await callback(new NextRequest(`${SITE}/admin/auth/callback?code=${"c".repeat(43)}&state=${"x".repeat(43)}`, { headers: { cookie: first.cookie } }));
    expect(wrong.headers.get("location")).toBe("/admin/auth/error");
    expect(calls).toHaveLength(0);

    const replay = await callback(new NextRequest(`${SITE}/admin/auth/callback?code=${"c".repeat(43)}&state=${first.location.searchParams.get("state")}`));
    expect(replay.headers.get("location")).toBe("/admin/auth/error");
    expect(calls).toHaveLength(0);

    const second = await startLogin();
    handler = (url) => url.pathname === "/api/auth/app-connect/exchange"
      ? json(200, { customToken: "custom", refreshToken: "refresh", connectionId: "connection-1", connectionExpiresAt: new Date(Date.now() + 8 * HOUR).toISOString(), user: {} })
      : url.hostname === "identitytoolkit.googleapis.com"
        ? json(200, { idToken: "id-1", expiresIn: "3600" })
        : json(403, { error: "forbidden" });
    const refused = await callback(new NextRequest(`${SITE}/admin/auth/callback?code=${"c".repeat(43)}&state=${second.location.searchParams.get("state")}`, { headers: { cookie: second.cookie } }));
    expect(refused.headers.get("location")).toBe("/admin/auth/error");
    expect(setCookies(refused).get(ADMIN_HTTP_SESSION_COOKIE)?.attributes).toMatch(/Max-Age=0/);
  });
});

describe("Admin HTTP refresh and cookie separation", () => {
  const post = (cookie: string, headers: Record<string, string> = sameOrigin) =>
    refresh(new NextRequest(`${SITE}/admin/auth/refresh`, { method: "POST", headers: { ...headers, cookie } }));

  it("rotates and verifies the short token without extending the original 8 hour deadline", async () => {
    const original = httpSession(4 * 60 * 1000);
    handler = (url) => {
      if (url.pathname === "/api/auth/app-connect/refresh") return json(200, { customToken: "custom-2", refreshToken: "refresh-2", connectionExpiresAt: new Date(original.connectionExpiresAt + HOUR).toISOString() });
      if (url.hostname === "identitytoolkit.googleapis.com") return json(200, { idToken: "id-2", expiresIn: "3600" });
      return json(200, { actor: { id: "admin-1", displayName: "Admin One" }, connection: { id: "connection-1", expiresAt: new Date(original.connectionExpiresAt + HOUR).toISOString() } });
    };
    const response = await post(sessionCookie(original));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ refreshed: true });
    expect(JSON.stringify(body)).not.toMatch(/refresh-2|id-2/);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ clientId: "niho-experience-admin", refreshToken: "refresh-1" });
    const renewed = decodeAdminHttpSession(
      new CookieSealer([state.config.adminSessionSecret], "admin-http-session"),
      setCookies(response).get(ADMIN_HTTP_SESSION_COOKIE)?.value,
      Date.now(),
    );
    expect(renewed).toMatchObject({ refreshToken: "refresh-2", idToken: "id-2", connectionExpiresAt: original.connectionExpiresAt });
  });

  it("clears the Admin session on 401/403 and refuses cross-site mutation", async () => {
    handler = () => json(403, { error: "role_lost" });
    const roleLost = await post(sessionCookie(httpSession(4 * 60 * 1000)));
    expect(roleLost.status).toBe(401);
    expect(setCookies(roleLost).get(ADMIN_HTTP_SESSION_COOKIE)?.attributes).toMatch(/Max-Age=0/);

    calls.length = 0;
    const crossSite = await post(sessionCookie(httpSession(4 * 60 * 1000)), { origin: "https://evil.example.test", "sec-fetch-site": "cross-site" });
    expect(crossSite.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("keeps the rotated refresh token when the later Firebase request has a network failure", async () => {
    const original = httpSession(4 * 60 * 1000);
    handler = async (url) => {
      if (url.pathname === "/api/auth/app-connect/refresh") {
        return json(200, {
          customToken: "custom-rotated",
          refreshToken: "refresh-rotated",
          connectionExpiresAt: new Date(original.connectionExpiresAt).toISOString(),
        });
      }
      throw new Error("firebase offline");
    };
    const response = await post(sessionCookie(original));
    expect(response.status).toBe(503);
    const kept = decodeAdminHttpSession(
      new CookieSealer([state.config.adminSessionSecret], "admin-http-session"),
      setCookies(response).get(ADMIN_HTTP_SESSION_COOKIE)?.value,
      Date.now(),
    );
    expect(kept).toMatchObject({ refreshToken: "refresh-rotated", idToken: "id-1", connectionExpiresAt: original.connectionExpiresAt });

    calls.length = 0;
    handler = async () => { throw new Error("NIHO offline"); };
    const unavailable = await post(sessionCookie(original));
    expect(unavailable.status).toBe(503);
    expect(decodeAdminHttpSession(
      new CookieSealer([state.config.adminSessionSecret], "admin-http-session"),
      setCookies(unavailable).get(ADMIN_HTTP_SESSION_COOKIE)?.value,
      Date.now(),
    )).toMatchObject({ refreshToken: "refresh-1", connectionExpiresAt: original.connectionExpiresAt });
  });

  it("does not accept the host or synthetic Admin preview cookie", async () => {
    const host = startSession({
      nihoUserId: "synthetic-host-user",
      refreshToken: "host-refresh",
      idToken: "host-id",
      idTokenExpiresAt: Date.now() + HOUR,
      connectionId: "host-connection",
      connectionExpiresAt: Date.now() + 24 * HOUR,
      displayName: "Host",
      iconUrl: null,
    }, Date.now());
    const hostValue = encodeSession(new CookieSealer([state.config.adminSessionSecret], "session"), host);
    expect((await post(`${ADMIN_HTTP_SESSION_COOKIE}=${hostValue}`)).status).toBe(401);

    const previewValue = encodeAdminSession(new CookieSealer([state.config.adminSessionSecret], "admin-preview-session"), startAdminSession("preview-session-1", Date.now()));
    expect((await post(`${ADMIN_HTTP_SESSION_COOKIE}=${previewValue}`)).status).toBe(401);
    expect(calls).toHaveLength(0);
  });
});

describe("Admin HTTP logout", () => {
  it("attempts own-connection revocation and always clears local cookies when NIHO is unavailable", async () => {
    handler = async () => { throw new Error("offline"); };
    const response = await logout(new NextRequest(`${SITE}/admin/auth/logout`, { method: "POST", headers: { ...sameOrigin, cookie: sessionCookie() } }));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/admin/auth/logout-unconfirmed");
    expect(calls[0]!.url.href).toBe(`${NIHO}/api/auth/app-connections/connection-1?reason=logout`);
    expect(calls[0]!.init.method).toBe("DELETE");
    expect(setCookies(response).get(ADMIN_HTTP_SESSION_COOKIE)?.attributes).toMatch(/Max-Age=0/);
    expect(setCookies(response).get(ADMIN_HTTP_LOGIN_COOKIE)?.attributes).toMatch(/Max-Age=0/);
  });

  it("does not treat an expired ID token response as confirmed revocation", async () => {
    handler = () => json(401, { error: "unauthenticated" });
    const response = await logout(new NextRequest(`${SITE}/admin/auth/logout`, { method: "POST", headers: { ...sameOrigin, cookie: sessionCookie() } }));
    expect(response.headers.get("location")).toBe("/admin/auth/logout-unconfirmed");
    expect(setCookies(response).get(ADMIN_HTTP_SESSION_COOKIE)?.attributes).toMatch(/Max-Age=0/);
  });

  it("returns to the entrance only after NIHO confirms revocation", async () => {
    handler = () => new Response(null, { status: 204 });
    const response = await logout(new NextRequest(`${SITE}/admin/auth/logout`, { method: "POST", headers: { ...sameOrigin, cookie: sessionCookie() } }));
    expect(response.headers.get("location")).toBe("/admin");
    expect(setCookies(response).get(ADMIN_HTTP_SESSION_COOKIE)?.attributes).toMatch(/Max-Age=0/);
  });
});
