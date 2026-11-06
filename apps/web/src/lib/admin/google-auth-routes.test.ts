import { createHash, randomBytes, randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Admin のログイン (ADR 0003 decision 4, EXPERIENCE_ADMIN_GOOGLE_LOGIN_ENABLED): the Google sign-in routes, the session
 * cookie, sign-out, the refresh no-op and the allowlist re-check, against a stubbed Google (token endpoint and
 * verifyIdToken) and an in-memory session store. No network; synthetic accounts only.
 */

const CLIENT_ID = "synthetic-client.apps.googleusercontent.com";
const SITE = "https://experience.example.test";
const SUBJECT = "100000000000000000001";

interface FakeSession { adminActorId: string; email: string; sessionRef: string; createdAt: number; revoked: boolean }

const state = vi.hoisted(() => ({
  config: {
    apiMode: "http",
    adminSupportConsoleEnabled: true,
    adminGoogleLoginEnabled: true,
    adminAllowedEmails: ["admin.sample@niho.life"] as readonly string[],
    adminSupportReadApiEnabled: false,
    hostConsoleEnabled: false,
    hostSessionSecret: "",
    adminSessionSecret: "synthetic-admin-route-secret-0123456789abcdef",
    adminOrigin: "https://experience.example.test",
    nihoFirebaseWebApiKey: "",
    nihoWebOrigin: "https://niho.example.test",
    siteUrl: "https://experience.example.test",
  },
  payload: undefined as Record<string, unknown> | undefined,
  verifyIdToken: vi.fn(),
  store: null as unknown,
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: state.config, isPreview: false }));
vi.mock("google-auth-library", () => ({
  OAuth2Client: class {
    verifyIdToken(input: unknown) {
      return state.verifyIdToken(input);
    }
  },
}));
vi.mock("@/lib/experience/store-server", () => ({ adminSessions: () => state.store }));

import { GET as googleLogin } from "@/app/(admin)/admin/auth/google/login/route";
import { GET as googleCallback } from "@/app/(admin)/admin/auth/google/callback/route";
import { GET as nihoLogin } from "@/app/(admin)/admin/auth/login/route";
import { GET as nihoCallback } from "@/app/(admin)/admin/auth/callback/route";
import { POST as refresh } from "@/app/(admin)/admin/auth/refresh/route";
import { POST as logout } from "@/app/(admin)/admin/auth/logout/route";
import { pkceChallenge } from "@/lib/host/pkce";
import {
  ADMIN_GOOGLE_LOGIN_COOKIE,
  ADMIN_GOOGLE_SESSION_COOKIE,
  adminGoogleIdentity,
  decodeAdminGoogleLogin,
  loadExperienceAdminSession,
} from "./google-login";
import { isAdminGoogleLogin, isAdminHttpRead, isAdminNihoLogin, loadNihoAdminHttpSession } from "./server";

const HOUR = 60 * 60 * 1000;
const ADMIN_ACTOR = `adm_${createHash("sha256").update(`google:${SUBJECT}`).digest("hex").slice(0, 32)}`;
const sameOrigin = { origin: SITE, "sec-fetch-site": "same-origin" };
const crossSite = { origin: "https://evil.example", "sec-fetch-site": "cross-site" };

const sessions = new Map<string, FakeSession>();
const sha = (token: string) => createHash("sha256").update(token).digest("hex");

/** An in-memory AdminSessions: the hash of the token is the key, as in the table. */
function fakeStore() {
  return {
    openSession: vi.fn(async ({ adminActorId, email, nowUtc }: { adminActorId: string; email: string; nowUtc: string }) => {
      const sessionToken = randomBytes(32).toString("base64url");
      const sessionRef = randomUUID();
      const createdAt = Date.parse(nowUtc);
      sessions.set(sha(sessionToken), { adminActorId, email, sessionRef, createdAt, revoked: false });
      return { sessionToken, sessionRef, adminActorId, absoluteExpiresAtUtc: new Date(createdAt + 12 * HOUR).toISOString() };
    }),
    readSession: vi.fn(async ({ sessionToken }: { sessionToken: string }) => {
      const found = sessions.get(sha(sessionToken));
      if (!found || found.revoked) return null;
      return {
        adminActorId: found.adminActorId,
        email: found.email,
        sessionRef: found.sessionRef,
        authenticatedAtUtc: new Date(found.createdAt).toISOString(),
        idleExpiresAtUtc: new Date(found.createdAt + 2 * HOUR).toISOString(),
        absoluteExpiresAtUtc: new Date(found.createdAt + 12 * HOUR).toISOString(),
      };
    }),
    revokeSession: vi.fn(async ({ sessionToken }: { sessionToken: string }) => {
      const found = sessions.get(sha(sessionToken));
      if (!found || found.revoked) return false;
      found.revoked = true;
      return true;
    }),
    revokeActorSessions: vi.fn(async ({ adminActorId }: { adminActorId: string }) => {
      let count = 0;
      for (const session of sessions.values()) if (session.adminActorId === adminActorId && !session.revoked) { session.revoked = true; count += 1; }
      return count;
    }),
  };
}

let store: ReturnType<typeof fakeStore>;

type TokenHandler = (form: URLSearchParams) => Response;
let tokenHandler: TokenHandler;
const fetchCalls: URL[] = [];
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  sessions.clear();
  fetchCalls.length = 0;
  state.config.adminGoogleLoginEnabled = true;
  state.config.adminAllowedEmails = ["admin.sample@niho.life"];
  state.config.adminSupportReadApiEnabled = false;
  store = fakeStore();
  state.store = store;
  state.payload = undefined;
  state.verifyIdToken.mockReset();
  state.verifyIdToken.mockImplementation(async () => ({ getPayload: () => state.payload }));
  vi.stubEnv("EXPERIENCE_GOOGLE_CLIENT_ID", CLIENT_ID);
  vi.stubEnv("EXPERIENCE_GOOGLE_CLIENT_SECRET", "synthetic-client-secret");
  tokenHandler = () => json(200, { access_token: "synthetic-access-token-never-kept", id_token: "synthetic.id.token", expires_in: 3599, token_type: "Bearer", scope: "openid email" });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    fetchCalls.push(url);
    if (url.href === "https://oauth2.googleapis.com/token") return tokenHandler(new URLSearchParams(String(init.body)));
    throw new Error(`unexpected ${url.href}`);
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function setCookies(response: Response): Map<string, { value: string; attributes: string }> {
  const result = new Map<string, { value: string; attributes: string }>();
  for (const header of response.headers.getSetCookie()) {
    const [pair = "", ...attributes] = header.split("; ");
    const index = pair.indexOf("=");
    result.set(pair.slice(0, index), { value: pair.slice(index + 1), attributes: attributes.join("; ") });
  }
  return result;
}

async function startLogin(query = "") {
  const response = googleLogin(new NextRequest(`${SITE}/admin/auth/google/login${query}`));
  const location = new URL(response.headers.get("location")!);
  const cookie = setCookies(response).get(ADMIN_GOOGLE_LOGIN_COOKIE)!;
  return { response, location, cookie, header: `${ADMIN_GOOGLE_LOGIN_COOKIE}=${cookie.value}` };
}

/** What Google's verified token says, for the nonce of the sign-in at `location`. */
function payloadFor(location: URL, overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: "https://accounts.google.com",
    aud: CLIENT_ID,
    azp: CLIENT_ID,
    sub: SUBJECT,
    email: "Admin.Sample@niho.life",
    email_verified: true,
    hd: "niho.life",
    nonce: location.searchParams.get("nonce"),
    iat: now,
    exp: now + 3600,
    ...overrides,
  };
}

function callbackRequest(login: { location: URL; header: string }, query?: Record<string, string>, extraCookie = "") {
  const params = new URLSearchParams(query ?? { code: "4/0Synthetic-Code_value", state: login.location.searchParams.get("state")!, scope: "email openid" });
  return new NextRequest(`${SITE}/admin/auth/google/callback?${params}`, { headers: { cookie: [login.header, extraCookie].filter(Boolean).join("; ") } });
}

function expectRefused(response: Response) {
  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toBe("/admin/auth/error");
  const cookies = setCookies(response);
  expect(cookies.get(ADMIN_GOOGLE_LOGIN_COOKIE)?.attributes).toContain("Max-Age=0");
  expect(cookies.has(ADMIN_GOOGLE_SESSION_COOKIE)).toBe(false);
  expect(store.openSession).not.toHaveBeenCalled();
}

describe("Admin Google sign-in: the authorize URL", () => {
  it("asks Google for openid email with PKCE S256, state, nonce and the niho.life hint, and seals them in a short HttpOnly cookie", async () => {
    const { response, location, cookie } = await startLogin("?returnTo=%2Fadmin%2Fnotifications");
    expect(response.status).toBe(303);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(`${location.origin}${location.pathname}`).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    const params = Object.fromEntries(location.searchParams);
    expect(params).toMatchObject({
      client_id: CLIENT_ID,
      redirect_uri: `${SITE}/admin/auth/google/callback`,
      response_type: "code",
      scope: "openid email",
      code_challenge_method: "S256",
      hd: "niho.life",
    });
    expect(params.access_type).toBeUndefined();
    expect(params.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(params.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(params.nonce).not.toBe(params.state);
    expect(params.code_challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);

    expect(cookie.attributes).toContain("Path=/admin/auth/google");
    expect(cookie.attributes).toContain("Max-Age=600");
    expect(cookie.attributes).toContain("HttpOnly");
    expect(cookie.attributes).toContain("Secure");
    expect(cookie.attributes.toLowerCase()).toContain("samesite=lax");
    const sealed = decodeAdminGoogleLogin(cookie.value, Date.now())!;
    expect(sealed).toMatchObject({ state: params.state, nonce: params.nonce, returnTo: "/admin/notifications" });
    expect(pkceChallenge(sealed.verifier)).toBe(params.code_challenge);
    for (const secret of [sealed.verifier, sealed.state, sealed.nonce]) expect(cookie.value).not.toContain(secret);
    // An open redirect falls back to the console's fixed page.
    expect(decodeAdminGoogleLogin((await startLogin("?returnTo=https%3A%2F%2Fevil.example")).cookie.value, Date.now())?.returnTo).toBe("/admin/bookings");
    expect(fetchCalls).toEqual([]);
  });
});

describe("Admin Google sign-in: the callback", () => {
  it("exchanges the code with the verifier, verifies the ID token and opens an Experience session for an allowlisted address", async () => {
    const login = await startLogin("?returnTo=%2Fadmin%2Fnotifications");
    const sealed = decodeAdminGoogleLogin(login.cookie.value, Date.now())!;
    state.payload = payloadFor(login.location);
    tokenHandler = (form) => {
      expect(Object.fromEntries(form)).toEqual({
        client_id: CLIENT_ID,
        client_secret: "synthetic-client-secret",
        grant_type: "authorization_code",
        code: "4/0Synthetic-Code_value",
        code_verifier: sealed.verifier,
        redirect_uri: `${SITE}/admin/auth/google/callback`,
      });
      return json(200, { access_token: "synthetic-access-token-never-kept", id_token: "synthetic.id.token", expires_in: 3599 });
    };
    const response = await googleCallback(callbackRequest(login));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/admin/notifications");
    expect(fetchCalls.map((url) => url.href)).toEqual(["https://oauth2.googleapis.com/token"]);
    expect(state.verifyIdToken).toHaveBeenCalledWith({ idToken: "synthetic.id.token", audience: CLIENT_ID });
    // The actor is derived from the subject, never the address; the address is kept in lower case.
    expect(store.openSession).toHaveBeenCalledWith({ adminActorId: ADMIN_ACTOR, email: "admin.sample@niho.life", nowUtc: expect.any(String) });

    const cookies = setCookies(response);
    const session = cookies.get(ADMIN_GOOGLE_SESSION_COOKIE)!;
    expect(session.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(session.attributes).toContain("Path=/");
    expect(session.attributes).not.toContain("Path=/admin");
    expect(session.attributes).toContain("HttpOnly");
    expect(session.attributes).toContain("Secure");
    expect(session.attributes.toLowerCase()).toContain("samesite=lax");
    expect(session.attributes).not.toContain("Domain");
    expect(Number(/Max-Age=(\d+)/.exec(session.attributes)?.[1])).toBeGreaterThan(12 * 3600 - 5);
    expect(cookies.get(ADMIN_GOOGLE_LOGIN_COOKIE)?.attributes).toContain("Max-Age=0");
    // Nothing from Google reaches the browser.
    const headers = JSON.stringify([...response.headers]);
    for (const secret of ["synthetic.id.token", "synthetic-access-token-never-kept", "4/0Synthetic"]) expect(headers).not.toContain(secret);

    // The session reads back as this admin, with no call to NIHO.
    const loaded = await loadExperienceAdminSession(session.value);
    expect(loaded).toMatchObject({ status: "ok", kind: "experience", actor: { id: ADMIN_ACTOR, displayName: "admin.sample@niho.life" } });
    expect(fetchCalls).toHaveLength(1);
  });

  it("ends the browser's previous session when it signs in again", async () => {
    const login = await startLogin();
    state.payload = payloadFor(login.location);
    const first = setCookies(await googleCallback(callbackRequest(login))).get(ADMIN_GOOGLE_SESSION_COOKIE)!.value;
    const again = await startLogin();
    state.payload = payloadFor(again.location);
    const response = await googleCallback(callbackRequest(again, undefined, `${ADMIN_GOOGLE_SESSION_COOKIE}=${first}`));
    expect(response.headers.get("location")).toBe("/admin/bookings");
    expect(store.revokeSession).toHaveBeenCalledWith({ sessionToken: first, nowUtc: expect.any(String) });
    expect(await loadExperienceAdminSession(first)).toEqual({ status: "rejected" });
  });

  it("refuses a missing or other sign-in's state, a missing cookie, and Google's error", async () => {
    const login = await startLogin();
    state.payload = payloadFor(login.location);
    expectRefused(await googleCallback(callbackRequest(login, { code: "4/0Synthetic", state: "x".repeat(43) })));
    expectRefused(await googleCallback(callbackRequest(login, { code: "4/0Synthetic" })));
    expectRefused(await googleCallback(new NextRequest(`${SITE}/admin/auth/google/callback?code=4%2F0Synthetic&state=${login.location.searchParams.get("state")}`)));
    expectRefused(await googleCallback(callbackRequest(login, { error: "access_denied", state: login.location.searchParams.get("state")! })));
    expectRefused(await googleCallback(callbackRequest(login, { code: "", state: login.location.searchParams.get("state")! })));
    expect(fetchCalls).toEqual([]);
  });

  it("refuses when Google refuses the code or is unavailable", async () => {
    const login = await startLogin();
    tokenHandler = () => json(400, { error: "invalid_grant" });
    expectRefused(await googleCallback(callbackRequest(login)));
    tokenHandler = () => json(503, { error: "unavailable" });
    expectRefused(await googleCallback(callbackRequest(login)));
    tokenHandler = () => json(200, { access_token: "only-an-access-token" });
    expectRefused(await googleCallback(callbackRequest(login)));
    expect(state.verifyIdToken).not.toHaveBeenCalled();
  });

  it("refuses an ID token whose signature does not verify", async () => {
    const login = await startLogin();
    state.verifyIdToken.mockRejectedValueOnce(new Error("Invalid token signature"));
    expectRefused(await googleCallback(callbackRequest(login)));
  });

  it("refuses another nonce, another Workspace domain, an unverified address and an address off the allowlist", async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["nonce mismatch", { nonce: "n".repeat(43) }],
      ["no nonce", { nonce: undefined }],
      ["wrong hd", { hd: "example.com" }],
      ["no hd (a consumer account)", { hd: undefined, email: "admin.sample@gmail.com" }],
      ["hd but another address domain", { email: "admin.sample@example.com" }],
      ["unverified email", { email_verified: false }],
      ["not allowlisted", { email: "stranger.sample@niho.life" }],
    ];
    for (const [label, overrides] of cases) {
      const login = await startLogin();
      state.payload = payloadFor(login.location, overrides);
      expectRefused(await googleCallback(callbackRequest(login)));
      expect(sessions.size, label).toBe(0);
    }
  });

  it("checks the claims again after google-auth-library: issuer, audience, expiry and subject", () => {
    const location = new URL("https://accounts.google.com/?nonce=" + "a".repeat(43));
    const expected = { clientId: CLIENT_ID, nonce: "a".repeat(43), now: Date.now() };
    const good = payloadFor(location) as never;
    expect(adminGoogleIdentity(good, expected)).toEqual({ sub: SUBJECT, email: "admin.sample@niho.life" });
    expect(adminGoogleIdentity(undefined, expected)).toBeNull();
    for (const overrides of [
      { iss: "https://evil.example" },
      { aud: "another-client" },
      { exp: Math.floor(Date.now() / 1000) - 1 },
      { sub: "" },
      { sub: "has space" },
      { email: undefined },
    ]) expect(adminGoogleIdentity(payloadFor(location, overrides) as never, expected), JSON.stringify(overrides)).toBeNull();
  });
});

describe("Admin Google sign-in: sessions on later requests", () => {
  async function signedIn(): Promise<string> {
    const login = await startLogin();
    state.payload = payloadFor(login.location);
    return setCookies(await googleCallback(callbackRequest(login))).get(ADMIN_GOOGLE_SESSION_COOKIE)!.value;
  }

  it("re-checks the allowlist on every request: a removed address stops at the next request and its sessions end", async () => {
    const token = await signedIn();
    expect((await loadExperienceAdminSession(token)).status).toBe("ok");
    state.config.adminAllowedEmails = ["other.sample@niho.life"];
    expect(await loadExperienceAdminSession(token)).toEqual({ status: "rejected" });
    expect(store.revokeActorSessions).toHaveBeenCalledWith({ adminActorId: ADMIN_ACTOR, nowUtc: expect.any(String) });
    // Put back on the list, the ended session stays ended: a new sign-in is needed.
    state.config.adminAllowedEmails = ["admin.sample@niho.life"];
    expect(await loadExperienceAdminSession(token)).toEqual({ status: "rejected" });
  });

  it("reads no cookie as signed out, a malformed one without the store, and a store failure as an error", async () => {
    expect(await loadExperienceAdminSession(undefined)).toEqual({ status: "signed-out" });
    expect(await loadExperienceAdminSession("not-a-token")).toEqual({ status: "signed-out" });
    expect(store.readSession).not.toHaveBeenCalled();
    const token = await signedIn();
    store.readSession.mockRejectedValueOnce(new Error("connection refused"));
    expect(await loadExperienceAdminSession(token)).toEqual({ status: "error" });
    expect(await loadExperienceAdminSession(token, null)).toEqual({ status: "error" });
  });

  it("refreshes as a no-op with the session's end, and 401 once the session ended, without calling anyone", async () => {
    const token = await signedIn();
    fetchCalls.length = 0;
    const request = (headers: Record<string, string>) => new NextRequest(`${SITE}/admin/auth/refresh`, { method: "POST", headers: { ...headers, cookie: `${ADMIN_GOOGLE_SESSION_COOKIE}=${token}` } });
    const ok = await refresh(request(sameOrigin));
    expect(ok.status).toBe(200);
    const body = await ok.json() as { refreshed: boolean; idTokenExpiresAt: number };
    expect(body.refreshed).toBe(false);
    expect(body.idTokenExpiresAt).toBeGreaterThan(Date.now() + 11 * HOUR);
    expect(setCookies(ok).size).toBe(0);
    expect((await refresh(request(crossSite))).status).toBe(403);
    await store.revokeSession({ sessionToken: token });
    const ended = await refresh(request(sameOrigin));
    expect(ended.status).toBe(401);
    expect(setCookies(ended).get(ADMIN_GOOGLE_SESSION_COOKIE)?.attributes).toContain("Max-Age=0");
    expect(fetchCalls).toEqual([]);
  });

  it("signs out: the session ends in the store and its cookie goes, same-origin only", async () => {
    const token = await signedIn();
    const request = (headers: Record<string, string>) => new NextRequest(`${SITE}/admin/auth/logout`, { method: "POST", headers: { ...headers, cookie: `${ADMIN_GOOGLE_SESSION_COOKIE}=${token}` } });
    expect((await logout(request(crossSite))).status).toBe(403);
    expect(store.revokeSession).not.toHaveBeenCalled();
    const response = await logout(request(sameOrigin));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/admin");
    expect(store.revokeSession).toHaveBeenCalledWith({ sessionToken: token, nowUtc: expect.any(String) });
    const cleared = setCookies(response).get(ADMIN_GOOGLE_SESSION_COOKIE)!;
    expect(cleared.value).toBe("");
    expect(cleared.attributes).toContain("Max-Age=0");
    expect(cleared.attributes).toContain("Path=/");
    expect(await loadExperienceAdminSession(token)).toEqual({ status: "rejected" });
    // An unreachable store still clears the cookie.
    store.revokeSession.mockRejectedValueOnce(new Error("connection refused"));
    expect(setCookies(await logout(request(sameOrigin))).get(ADMIN_GOOGLE_SESSION_COOKIE)?.attributes).toContain("Max-Age=0");
    expect(fetchCalls.filter((url) => url.hostname !== "oauth2.googleapis.com")).toEqual([]);
  });
});

describe("Admin login modes", () => {
  it("closes the Google routes while the flag is off, and the NIHO routes and NIHO token while it is on", async () => {
    expect(isAdminGoogleLogin()).toBe(true);
    expect(isAdminNihoLogin()).toBe(false);
    state.config.adminSupportReadApiEnabled = true;
    expect(isAdminHttpRead()).toBe(false);
    expect((nihoLogin(new NextRequest(`${SITE}/admin/auth/login`))).status).toBe(404);
    expect((await nihoCallback(new NextRequest(`${SITE}/admin/auth/callback?code=${"c".repeat(43)}`))).status).toBe(404);
    // Code that sends NIHO's admin token never gets one in this mode.
    expect(await loadNihoAdminHttpSession()).toEqual({ status: "error" });

    state.config.adminGoogleLoginEnabled = false;
    expect(isAdminGoogleLogin()).toBe(false);
    expect(isAdminNihoLogin()).toBe(true);
    expect(isAdminHttpRead()).toBe(true);
    expect(googleLogin(new NextRequest(`${SITE}/admin/auth/google/login`)).status).toBe(404);
    expect((await googleCallback(new NextRequest(`${SITE}/admin/auth/google/callback?code=x&state=y`))).status).toBe(404);
    expect(fetchCalls).toEqual([]);
  });
});
