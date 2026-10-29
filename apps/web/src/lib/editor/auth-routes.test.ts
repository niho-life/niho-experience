import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  config: {
    apiMode: "http",
    editorConsoleEnabled: true,
    editorSessionSecret: "synthetic-editor-route-secret-0123456789abcdef",
    editorOrigin: "https://experience.example.test",
    nihoFirebaseWebApiKey: "synthetic-firebase-key",
    nihoWebOrigin: "https://niho.example.test",
    siteUrl: "https://experience.example.test",
  },
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: state.config, isPreview: false }));

import { GET as login } from "@/app/(editor)/editor/auth/login/route";
import { GET as callback } from "@/app/(editor)/editor/auth/callback/route";
import { POST as refresh } from "@/app/(editor)/editor/auth/refresh/route";
import { POST as logout } from "@/app/(editor)/editor/auth/logout/route";
import { CookieSealer } from "@/lib/host/cookie-seal";
import {
  EDITOR_LOGIN_COOKIE,
  EDITOR_SESSION_COOKIE,
  decodeEditorLogin,
  decodeEditorSession,
  encodeEditorSession,
  startEditorSession,
} from "./session";

const SITE = state.config.siteUrl;
const NIHO = state.config.nihoWebOrigin;
const HOUR = 60 * 60 * 1000;
const sameOrigin = { origin: SITE, "sec-fetch-site": "same-origin" };

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;
let handler: Handler;
const calls: Array<{ url: URL; init: RequestInit }> = [];

beforeEach(() => {
  state.config.editorConsoleEnabled = true;
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

function editorSession(idTokenExpiresIn = HOUR) {
  const now = Date.now();
  return startEditorSession({
    refreshToken: "refresh-1",
    idToken: "id-1",
    idTokenExpiresAt: now + idTokenExpiresIn,
    connectionId: "connection-1",
    exchangedConnectionExpiresAt: now + 24 * HOUR,
    verifiedConnectionExpiresAt: now + 24 * HOUR,
    actorId: "actor-1",
  }, now)!;
}

function sessionCookie(session = editorSession()) {
  const value = encodeEditorSession(new CookieSealer([state.config.editorSessionSecret], "editor-http-session"), session);
  return `${EDITOR_SESSION_COOKIE}=${value}`;
}

function successfulAuth(connectionExpiresAt: number, active = true) {
  handler = (url, init) => {
    if (url.pathname === "/api/auth/app-connect/exchange") {
      expect(JSON.parse(String(init.body))).toMatchObject({ clientId: "niho-experience-editor", code: "c".repeat(43) });
      return json(200, {
        customToken: "custom-1",
        refreshToken: "refresh-1",
        connectionId: "connection-1",
        connectionExpiresAt: new Date(connectionExpiresAt).toISOString(),
      });
    }
    if (url.hostname === "identitytoolkit.googleapis.com") {
      return json(200, { idToken: "id-1", expiresIn: "3600", refreshToken: "firebase-token-must-not-be-kept" });
    }
    if (url.pathname === "/api/auth/app-connect/experience-editor/session") {
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer id-1");
      return json(200, {
        actor: { id: "actor-1", email: "must-not-leak@example.test" },
        connection: { id: "connection-1", expiresAt: new Date(connectionExpiresAt).toISOString() },
        account: { active },
      });
    }
    throw new Error(`unexpected ${url.href}`);
  };
}

async function startLogin() {
  const response = login();
  const location = new URL(response.headers.get("location")!);
  const cookie = setCookies(response).get(EDITOR_LOGIN_COOKIE)!;
  return { response, location, cookie: `${EDITOR_LOGIN_COOKIE}=${cookie.value}`, rawCookie: cookie };
}

describe("editor login and callback", () => {
  it("stays at 404 while the explicit rollout gate is closed", async () => {
    state.config.editorConsoleEnabled = false;
    expect(login().status).toBe(404);
    expect((await callback(new NextRequest(`${SITE}/editor/auth/callback`))).status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("uses PKCE/state and an isolated short login cookie", async () => {
    const { response, location, rawCookie } = await startLogin();
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(location.origin + location.pathname).toBe(`${NIHO}/connect/niho-experience-editor`);
    expect(location.searchParams.get("challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(location.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(location.searchParams.get("origin")).toBe(SITE);
    expect(rawCookie.attributes).toMatch(/Path=\/editor\/auth/);
    expect(rawCookie.attributes).toMatch(/Max-Age=600/);
    expect(rawCookie.attributes).toMatch(/HttpOnly/);
    expect(rawCookie.attributes).toMatch(/Secure/);
    expect(rawCookie.attributes).toMatch(/SameSite=lax/i);
    expect(decodeEditorLogin(new CookieSealer([state.config.editorSessionSecret], "editor-http-login"), rawCookie.value, Date.now())).not.toBeNull();
  });

  it("verifies active account and connection, then always lands on the fixed guides path", async () => {
    const expiresAt = Date.now() + 24 * HOUR;
    successfulAuth(expiresAt);
    const { location, cookie } = await startLogin();
    const response = await callback(new NextRequest(`${SITE}/editor/auth/callback?code=${"c".repeat(43)}&state=${location.searchParams.get("state")}&returnTo=https://evil.example`, { headers: { cookie } }));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/editor/guides");
    const cookies = setCookies(response);
    expect(cookies.get(EDITOR_LOGIN_COOKIE)?.attributes).toMatch(/Max-Age=0/);
    const sealed = cookies.get(EDITOR_SESSION_COOKIE)!;
    expect(sealed.attributes).toMatch(/Path=\/editor;/);
    expect(sealed.value).not.toMatch(/refresh-1|id-1|actor-1/);
    const decoded = decodeEditorSession(new CookieSealer([state.config.editorSessionSecret], "editor-http-session"), sealed.value, Date.now());
    expect(decoded).toMatchObject({ actorId: "actor-1", connectionId: "connection-1" });
    expect(JSON.stringify(decoded)).not.toContain("firebase-token-must-not-be-kept");
  });

  it("rejects wrong state, missing state and an inactive account without making a local bypass", async () => {
    const first = await startLogin();
    const wrong = await callback(new NextRequest(`${SITE}/editor/auth/callback?code=${"c".repeat(43)}&state=${"x".repeat(43)}`, { headers: { cookie: first.cookie } }));
    expect(wrong.headers.get("location")).toBe("/editor/auth/error");
    expect(calls).toHaveLength(0);

    const second = await startLogin();
    successfulAuth(Date.now() + 24 * HOUR, false);
    const inactive = await callback(new NextRequest(`${SITE}/editor/auth/callback?code=${"c".repeat(43)}&state=${second.location.searchParams.get("state")}`, { headers: { cookie: second.cookie } }));
    expect(inactive.headers.get("location")).toBe("/editor/auth/error");
    expect(setCookies(inactive).has(EDITOR_SESSION_COOKIE)).toBe(false);
  });

  it("does not log out an existing session when an unsolicited callback has no matching login state", async () => {
    const started = await startLogin();
    for (const cookie of [sessionCookie(), `${started.cookie}; ${sessionCookie()}`]) {
      const response = await callback(new NextRequest(`${SITE}/editor/auth/callback?code=${"c".repeat(43)}&state=${"x".repeat(43)}`, {
        headers: { cookie },
      }));
      expect(response.headers.get("location")).toBe("/editor/auth/error");
      expect(setCookies(response).has(EDITOR_SESSION_COOKIE)).toBe(false);
      expect(setCookies(response).get(EDITOR_LOGIN_COOKIE)?.attributes).toMatch(/Max-Age=0/);
    }
    expect(calls).toHaveLength(0);
  });
});
describe("editor refresh rotation", () => {
  const post = (cookie: string, headers: Record<string, string> = sameOrigin) =>
    refresh(new NextRequest(`${SITE}/editor/auth/refresh`, { method: "POST", headers: { ...headers, cookie } }));

  it("serially rotates and verifies without extending the connection deadline", async () => {
    const original = editorSession(4 * 60 * 1000);
    handler = (url) => {
      if (url.pathname === "/api/auth/app-connect/refresh") return json(200, { customToken: "custom-2", refreshToken: "refresh-2", connectionExpiresAt: new Date(original.connectionExpiresAt + HOUR).toISOString() });
      if (url.hostname === "identitytoolkit.googleapis.com") return json(200, { idToken: "id-2", expiresIn: "3600" });
      return json(200, { actor: { id: "actor-1" }, connection: { id: "connection-1", expiresAt: new Date(original.connectionExpiresAt).toISOString() }, account: { active: true } });
    };
    const response = await post(sessionCookie(original));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ refreshed: true });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ clientId: "niho-experience-editor", refreshToken: "refresh-1" });
    const renewed = decodeEditorSession(
      new CookieSealer([state.config.editorSessionSecret], "editor-http-session"),
      setCookies(response).get(EDITOR_SESSION_COOKIE)?.value,
      Date.now(),
    );
    expect(renewed).toMatchObject({ refreshToken: "refresh-2", idToken: "id-2", connectionExpiresAt: original.connectionExpiresAt });
  });

  it("discards the old token after an ambiguous rotation failure", async () => {
    handler = async () => { throw new Error("response lost"); };
    const response = await post(sessionCookie(editorSession(4 * 60 * 1000)));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "refresh_state_unknown" });
    expect(setCookies(response).get(EDITOR_SESSION_COOKIE)?.attributes).toMatch(/Max-Age=0/);
  });

  it("reseals only the rotated token when a later Firebase step is unavailable", async () => {
    const original = editorSession(4 * 60 * 1000);
    handler = async (url) => {
      if (url.pathname === "/api/auth/app-connect/refresh") {
        return json(200, { customToken: "custom-2", refreshToken: "refresh-2", connectionExpiresAt: new Date(original.connectionExpiresAt).toISOString() });
      }
      throw new Error("firebase offline");
    };
    const response = await post(sessionCookie(original));
    expect(response.status).toBe(503);
    const kept = decodeEditorSession(
      new CookieSealer([state.config.editorSessionSecret], "editor-http-session"),
      setCookies(response).get(EDITOR_SESSION_COOKIE)?.value,
      Date.now(),
    );
    expect(kept).toMatchObject({ refreshToken: "refresh-2" });
    expect(kept?.refreshToken).not.toBe("refresh-1");
  });

  it("rechecks current account activity even when token rotation is not due", async () => {
    handler = () => json(200, {
      actor: { id: "actor-1" },
      connection: { id: "connection-1", expiresAt: new Date(Date.now() + 23 * HOUR).toISOString() },
      account: { active: false },
    });
    const response = await post(sessionCookie());
    expect(response.status).toBe(401);
    expect(setCookies(response).get(EDITOR_SESSION_COOKIE)?.attributes).toMatch(/Max-Age=0/);
    expect(calls[0]!.url.pathname).toBe("/api/auth/app-connect/experience-editor/session");
  });

  it("refuses cross-site requests and rejects cookies sealed for another purpose", async () => {
    const crossSite = await post(sessionCookie(editorSession(4 * 60 * 1000)), { origin: "https://evil.example.test", "sec-fetch-site": "cross-site" });
    expect(crossSite.status).toBe(403);

    const wrongPurpose = encodeEditorSession(new CookieSealer([state.config.editorSessionSecret], "admin-http-session"), editorSession(4 * 60 * 1000));
    const rejected = await post(`${EDITOR_SESSION_COOKIE}=${wrongPurpose}`);
    expect(rejected.status).toBe(401);
    expect(calls).toHaveLength(0);
  });
});

describe("editor logout", () => {
  it("best-effort revokes only its own connection and always clears local cookies", async () => {
    handler = async () => { throw new Error("NIHO unavailable"); };
    const response = await logout(new NextRequest(`${SITE}/editor/auth/logout`, { method: "POST", headers: { ...sameOrigin, cookie: sessionCookie() } }));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/editor/auth/login");
    expect(calls[0]!.url.href).toBe(`${NIHO}/api/auth/app-connections/connection-1?reason=logout`);
    expect(setCookies(response).get(EDITOR_SESSION_COOKIE)?.attributes).toMatch(/Max-Age=0/);
    expect(setCookies(response).get(EDITOR_LOGIN_COOKIE)?.attributes).toMatch(/Max-Age=0/);
  });

  it("does not change cookies while disabled or when the mutation is cross-site", async () => {
    state.config.editorConsoleEnabled = false;
    const disabled = await logout(new NextRequest(`${SITE}/editor/auth/logout`, { method: "POST" }));
    expect(disabled.status).toBe(404);
    expect(setCookies(disabled).size).toBe(0);

    state.config.editorConsoleEnabled = true;
    const crossSite = await logout(new NextRequest(`${SITE}/editor/auth/logout`, { method: "POST", headers: { origin: "https://evil.example.test", "sec-fetch-site": "cross-site", cookie: sessionCookie() } }));
    expect(crossSite.status).toBe(403);
    expect(setCookies(crossSite).size).toBe(0);
    expect(calls).toHaveLength(0);
  });
});
