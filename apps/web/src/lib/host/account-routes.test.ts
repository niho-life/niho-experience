import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StoreValidationError, type HostLoginRequestAccepted, type HostLoginResult, type HostSession as StoredHostSession } from "@niho-experience/experience-store";

/** The email sign-in of Experience host accounts (ADR 0003 slice 2) against a stubbed store: synthetic data only. */
const state = vi.hoisted(() => ({
  config: {
    apiMode: "http",
    hostConsoleEnabled: true,
    hostAccountsEnabled: true,
    hostPwaEnabled: false,
    hostPushEnabled: false,
    hostSessionSecret: "synthetic-route-test-secret-0123456789abcdef",
    nihoWebOrigin: "https://niho.example.test",
    siteUrl: "https://experience.example.test",
  },
  store: null as Record<string, ReturnType<typeof import("vitest").vi.fn>> | null,
  pool: null as { query: (sql: string, params: unknown[]) => Promise<{ rowCount: number; rows: unknown[] }> } | null,
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: state.config, isPreview: false }));
vi.mock("@/lib/experience/store-server", () => ({ hostAccounts: () => state.store, experiencePool: () => state.pool }));

import { POST as requestLink } from "@/app/(host)/host/auth/email/route";
import { GET as openPage, POST as openLink } from "@/app/(host)/host/auth/open/route";
import { POST as logout } from "@/app/(host)/host/auth/logout/route";
import { POST as refresh } from "@/app/(host)/host/auth/refresh/route";
import { GET as login } from "@/app/(host)/host/auth/login/route";
import { GET as callback } from "@/app/(host)/host/auth/callback/route";
import { GET as relayGet } from "@/app/(host)/host/api/[...path]/route";
import { cookieSealer } from "./cookie-seal";
import { ACCOUNT_SESSION_COOKIE, encodeSession, LINK_BINDING_COOKIE, SESSION_COOKIE, startSession } from "./session";

const SITE = state.config.siteUrl;
const DAY = 86_400_000;
const sameOrigin = { origin: SITE, "sec-fetch-site": "same-origin" };
const form = { ...sameOrigin, "content-type": "application/x-www-form-urlencoded" };
const ADDRESS = "synthetic-host@example.test";
/** 32 random bytes in base64url are 43 characters. */
const secret = (label: string) => label.padEnd(43, "x");
const BINDING = secret("bindingValue");
const LINK_TOKEN = secret("linkToken");
const SESSION_TOKEN = secret("sessionToken");
const OLD_SESSION_TOKEN = secret("oldSessionToken");
const HOST = `hst_${"a".repeat(32)}`;
const REF = "0f8fad5b-d9cb-469f-a165-70867728950e";
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest();

function setCookies(response: Response): Map<string, { value: string; attributes: string }> {
  const cookies = new Map<string, { value: string; attributes: string }>();
  for (const header of response.headers.getSetCookie()) {
    const [pair = "", ...attributes] = header.split("; ");
    const index = pair.indexOf("=");
    cookies.set(pair.slice(0, index), { value: pair.slice(index + 1), attributes: attributes.join("; ") });
  }
  return cookies;
}

const storedSession = () => ({
  hostAccountId: HOST,
  email: ADDRESS,
  sessionRef: REF,
  authenticatedAtUtc: new Date(Date.now() - 60_000).toISOString(),
  idleExpiresAtUtc: new Date(Date.now() + 14 * DAY).toISOString(),
  absoluteExpiresAtUtc: new Date(Date.now() + 29 * DAY).toISOString(),
});

function fakeStore() {
  return {
    requestLogin: vi.fn<(input: { email: string; browserBindingHash: Uint8Array; nowUtc: string }) => Promise<HostLoginRequestAccepted>>(async () => ({ kind: "accepted" })),
    consumeLogin: vi.fn<(input: { token: string; browserBindingHash: Uint8Array; nowUtc: string }) => Promise<HostLoginResult>>(async () => ({ kind: "ok" as const, sessionToken: SESSION_TOKEN, sessionRef: REF, hostAccountId: HOST, absoluteExpiresAtUtc: new Date(Date.now() + 30 * DAY).toISOString() })),
    readSession: vi.fn<(input: { sessionToken: string; nowUtc: string }) => Promise<StoredHostSession | null>>(async () => storedSession()),
    revokeSession: vi.fn<(input: { sessionToken: string; nowUtc: string }) => Promise<boolean>>(async () => true),
  };
}
let store: ReturnType<typeof fakeStore>;

const post = (path: string, body: string, headers: Record<string, string> = {}) =>
  new NextRequest(`${SITE}${path}`, { method: "POST", headers: { ...form, ...headers }, body });

beforeEach(() => {
  Object.assign(state.config, { hostConsoleEnabled: true, hostAccountsEnabled: true, hostPwaEnabled: false, hostPushEnabled: false });
  store = fakeStore();
  state.store = store as unknown as typeof state.store;
  state.pool = null;
});
afterEach(() => vi.restoreAllMocks());

describe("routes while the flag is off", () => {
  it("are all 404 and the NIHO login stays", async () => {
    state.config.hostAccountsEnabled = false;
    expect((await requestLink(post("/host/auth/email", `email=${encodeURIComponent(ADDRESS)}`))).status).toBe(404);
    expect(openPage().status).toBe(404);
    expect((await openLink(post("/host/auth/open", `t=${LINK_TOKEN}`, { cookie: `${LINK_BINDING_COOKIE}=${BINDING}` }))).status).toBe(404);
    expect(new URL(login(new NextRequest(`${SITE}/host/auth/login`)).headers.get("location")!, SITE).origin).toBe(state.config.nihoWebOrigin);
    expect(store.requestLogin).not.toHaveBeenCalled();
    expect(store.consumeLogin).not.toHaveBeenCalled();
  });
});

describe("sign-in entry with host accounts on", () => {
  it("sends every 「ログイン」 link to the email form and closes the NIHO callback and relay", async () => {
    const response = login(new NextRequest(`${SITE}/host/auth/login?surface=app&providerId=p_1`));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/host/auth/sign-in");
    expect(response.headers.getSetCookie()).toEqual([]);
    expect((await callback(new NextRequest(`${SITE}/host/auth/callback?code=c&state=s`))).status).toBe(404);
    // A NIHO cookie left from before the switch is never relayed.
    const now = Date.now();
    const niho = encodeSession(cookieSealer(state.config.hostSessionSecret, "session"), startSession({ refreshToken: "r", accessToken: "a", accessTokenExpiresAt: now + 3_600_000, connectionId: "c", connectionExpiresAt: now + DAY, displayName: "", iconUrl: null }, now));
    const relayed = await relayGet(new NextRequest(`${SITE}/host/api/auth/me`, { headers: { cookie: `${SESSION_COOKIE}=${niho}` } }), { params: Promise.resolve({ path: ["auth", "me"] }) });
    expect(relayed.status).toBe(404);
  });
});

describe("POST /host/auth/email", () => {
  it("answers the same 303 with the same link cookie whatever the store did, and binds the request to this browser", async () => {
    const answers = [];
    for (const address of [ADDRESS, "nobody-here@example.test"]) {
      const response = await requestLink(post("/host/auth/email", `email=${encodeURIComponent(address)}`));
      const cookie = setCookies(response).get(LINK_BINDING_COOKIE)!;
      answers.push({ status: response.status, location: response.headers.get("location"), cacheControl: response.headers.get("cache-control"), attributes: cookie.attributes });
      // The store gets the SHA-256 of the cookie's random value, never the value itself.
      const call = store.requestLogin.mock.calls.at(-1)![0];
      expect(call.email).toBe(address);
      expect(cookie.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(call.browserBindingHash).equals(sha256(cookie.value))).toBe(true);
      expect(call.nowUtc).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    }
    expect(answers[0]).toEqual(answers[1]);
    expect(answers[0]).toMatchObject({ status: 303, location: "/host/auth/sign-in?sent=1", cacheControl: "private, no-store" });
    // HttpOnly, Secure, SameSite=Lax, on the auth path only, for the link's 15 minutes.
    expect(answers[0]!.attributes).toMatch(/Path=\/host\/auth(;|$)/);
    expect(answers[0]!.attributes).toMatch(/Max-Age=900/);
    expect(answers[0]!.attributes).toMatch(/Secure/);
    expect(answers[0]!.attributes).toMatch(/HttpOnly/);
    expect(answers[0]!.attributes).toMatch(/SameSite=lax/i);
  });

  it("keeps the link cookie a browser already holds, so each link it asked for opens there", async () => {
    const response = await requestLink(post("/host/auth/email", `email=${encodeURIComponent(ADDRESS)}`, { cookie: `${LINK_BINDING_COOKIE}=${BINDING}` }));
    expect(setCookies(response).get(LINK_BINDING_COOKIE)!.value).toBe(BINDING);
    const call = store.requestLogin.mock.calls[0]![0];
    expect(Buffer.from(call.browserBindingHash).equals(sha256(BINDING))).toBe(true);
  });

  it("sends a malformed address back to the form, a store outage to its notice, and never logs the address", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    store.requestLogin.mockRejectedValueOnce(new StoreValidationError("email must be an email address of 3-254 characters."));
    const invalid = await requestLink(post("/host/auth/email", "email=not-an-address"));
    expect(invalid.headers.get("location")).toBe("/host/auth/sign-in?error=email");
    expect(invalid.headers.getSetCookie()).toEqual([]);
    store.requestLogin.mockRejectedValueOnce(Object.assign(new Error(`connection refused for ${ADDRESS}`), { name: "DatabaseError" }));
    const down = await requestLink(post("/host/auth/email", `email=${encodeURIComponent(ADDRESS)}`));
    expect(down.headers.get("location")).toBe("/host/auth/sign-in?error=unavailable");
    expect(errors.mock.calls.flat().join(" ")).not.toContain(ADDRESS);
    expect(errors.mock.calls.flat().join(" ")).toContain("DatabaseError");
  });

  it("refuses cross-site posts and anything but a one-field form", async () => {
    expect((await requestLink(post("/host/auth/email", `email=${encodeURIComponent(ADDRESS)}`, { origin: "https://evil.example.test", "sec-fetch-site": "cross-site" }))).status).toBe(403);
    expect((await requestLink(post("/host/auth/email", JSON.stringify({ email: ADDRESS }), { "content-type": "application/json" }))).status).toBe(415);
    expect((await requestLink(post("/host/auth/email", `email=${ADDRESS}&next=/x`))).status).toBe(400);
    expect((await requestLink(post("/host/auth/email", `email=${"a".repeat(2000)}`))).status).toBe(413);
    expect(store.requestLogin).not.toHaveBeenCalled();
  });
});

describe("GET /host/auth/open", () => {
  it("is a private, unindexed page that takes the token from the fragment and posts it same-origin", async () => {
    const response = openPage();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    const html = await response.text();
    expect(html).toContain('<html lang="ja">');
    expect(html).toContain("history.replaceState");
    expect(html).toContain('referrerPolicy:"same-origin"');
    expect(html).toContain('redirect:"error"');
    expect(html).toContain('"/host/auth/error?reason=link"');
    expect(html).toContain("<noscript>");
    // The inline script is valid JavaScript, and the page carries no token of its own.
    const script = /<script>([\s\S]*)<\/script>/.exec(html)![1]!;
    expect(() => new Function(script)).not.toThrow();
    expect(html).not.toMatch(/[A-Za-z0-9_-]{43}/);
  });

  it("runs in a browser: takes the token out of the address bar, posts it, and opens the console or the error page", async () => {
    const html = await openPage().text();
    const script = /<script>([\s\S]*)<\/script>/.exec(html)![1]!;
    const run = async (hash: string, answer: Partial<Response>) => {
      const replaced: string[] = [];
      const posted: { url: string; init: RequestInit }[] = [];
      const status = { textContent: "" };
      const retry = { hidden: true, addEventListener: vi.fn() };
      const location = { hash, pathname: "/host/auth/open", search: "", replace: (to: string) => replaced.push(to) };
      const history = { state: null, replaceState: vi.fn((_state: unknown, _title: string, url: string) => { location.hash = ""; replaced.push(`history:${url}`); }) };
      const fetchStub = vi.fn(async (url: string, init: RequestInit) => { posted.push({ url, init }); return answer as Response; });
      new Function("location", "history", "document", "fetch", "URLSearchParams", script)(
        location, history, { getElementById: (id: string) => (id === "status" ? status : retry) }, fetchStub, URLSearchParams,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      return { replaced, posted, status, retry };
    };
    const ok = await run(`#t=${LINK_TOKEN}`, { type: "basic", status: 204 } as Partial<Response>);
    expect(ok.replaced).toEqual(["history:/host/auth/open", "/host/home"]);
    expect(ok.posted).toEqual([{ url: "/host/auth/open", init: expect.objectContaining({ method: "POST", body: `t=${LINK_TOKEN}`, credentials: "same-origin", redirect: "error", referrerPolicy: "same-origin" }) }]);
    expect((await run(`#t=${LINK_TOKEN}`, { type: "basic", status: 400 } as Partial<Response>)).replaced.at(-1)).toBe("/host/auth/error?reason=link");
    const failed = await run(`#t=${LINK_TOKEN}`, { type: "basic", status: 503 } as Partial<Response>);
    expect(failed.replaced).toEqual(["history:/host/auth/open"]);
    expect(failed.retry.hidden).toBe(false);
    const missing = await run("", {});
    expect(missing.posted).toEqual([]);
    expect(missing.replaced).toEqual(["/host/auth/error?reason=link"]);
  });
});

describe("POST /host/auth/open", () => {
  const open = (cookie: string, token = LINK_TOKEN) => openLink(post("/host/auth/open", `t=${token}`, cookie ? { cookie } : {}));

  it("opens a session in the browser that asked: the session cookie and the link cookie cleared on a plain 204", async () => {
    const before = Date.now();
    const response = await open(`${LINK_BINDING_COOKIE}=${BINDING}`);
    expect(response.status).toBe(204);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const call = store.consumeLogin.mock.calls[0]![0];
    expect(call.token).toBe(LINK_TOKEN);
    expect(Buffer.from(call.browserBindingHash).equals(sha256(BINDING))).toBe(true);
    const cookies = setCookies(response);
    const session = cookies.get(ACCOUNT_SESSION_COOKIE)!;
    expect(ACCOUNT_SESSION_COOKIE.startsWith("__Host-")).toBe(true);
    expect(session.value).toBe(SESSION_TOKEN);
    expect(session.attributes).toMatch(/Path=\/(;|$)/);
    expect(session.attributes).toMatch(/Secure/);
    expect(session.attributes).toMatch(/HttpOnly/);
    expect(session.attributes).toMatch(/SameSite=lax/i);
    expect(session.attributes).not.toMatch(/Domain=/i);
    // No longer than the session's absolute end (30 days).
    const maxAge = Number(/Max-Age=(\d+)/.exec(session.attributes)![1]);
    expect(maxAge).toBeGreaterThan(30 * 86_400 - 5 - Math.ceil((Date.now() - before) / 1000));
    expect(maxAge).toBeLessThanOrEqual(30 * 86_400);
    expect(cookies.get(LINK_BINDING_COOKIE)).toMatchObject({ value: "" });
    expect(cookies.get(LINK_BINDING_COOKIE)!.attributes).toMatch(/Max-Age=0/);
    expect(store.revokeSession).not.toHaveBeenCalled();
  });

  it("signs out the session this browser held before", async () => {
    const response = await open(`${LINK_BINDING_COOKIE}=${BINDING}; ${ACCOUNT_SESSION_COOKIE}=${OLD_SESSION_TOKEN}`);
    expect(response.status).toBe(204);
    expect(store.revokeSession).toHaveBeenCalledWith(expect.objectContaining({ sessionToken: OLD_SESSION_TOKEN }));
  });

  it("answers 400 for a link that cannot be used (another browser, expired, used), setting no session", async () => {
    store.consumeLogin.mockResolvedValueOnce({ kind: "invalid" });
    const refused = await open(`${LINK_BINDING_COOKIE}=${BINDING}`);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: "link_invalid" });
    expect(refused.headers.getSetCookie()).toEqual([]);
    // No link cookie: a different browser. The store is not even asked.
    const elsewhere = await open("");
    expect(elsewhere.status).toBe(400);
    expect((await open(`${LINK_BINDING_COOKIE}=${BINDING}`, "short"))).toMatchObject({ status: 400 });
    expect(store.consumeLogin).toHaveBeenCalledOnce();
  });

  it("refuses cross-site posts, and answers 503 without detail when the store fails", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await openLink(post("/host/auth/open", `t=${LINK_TOKEN}`, { cookie: `${LINK_BINDING_COOKIE}=${BINDING}`, origin: "https://evil.example.test", "sec-fetch-site": "cross-site" }))).status).toBe(403);
    store.consumeLogin.mockRejectedValueOnce(new Error(`db down near ${LINK_TOKEN}`));
    const down = await open(`${LINK_BINDING_COOKIE}=${BINDING}`);
    expect(down.status).toBe(503);
    expect(await down.text()).not.toContain(LINK_TOKEN);
    expect(errors.mock.calls.flat().join(" ")).not.toContain(LINK_TOKEN);
  });
});

describe("logout and refresh with host accounts", () => {
  it("logout revokes the session in the store, forgets its devices' push and clears the cookie", async () => {
    Object.assign(state.config, { hostPushEnabled: true });
    const queries: { sql: string; params: unknown[] }[] = [];
    state.pool = { query: async (sql, params) => { queries.push({ sql, params }); return { rowCount: 1, rows: [] }; } };
    const response = await logout(new NextRequest(`${SITE}/host/auth/logout`, { method: "POST", headers: { ...sameOrigin, cookie: `${ACCOUNT_SESSION_COOKIE}=${SESSION_TOKEN}` } }));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/host");
    expect(store.revokeSession).toHaveBeenCalledWith(expect.objectContaining({ sessionToken: SESSION_TOKEN }));
    expect(queries).toEqual([{ sql: expect.stringMatching(/^DELETE FROM host_push_subscriptions WHERE connection_id = \$1/), params: [REF] }]);
    const cookie = setCookies(response).get(ACCOUNT_SESSION_COOKIE)!;
    expect(cookie.value).toBe("");
    expect(cookie.attributes).toMatch(/Max-Age=0/);
    expect(cookie.attributes).toMatch(/Path=\/(;|$)/);
    // With the app on, the host goes to its start page (the cookie does not say where it was signed in).
    state.config.hostPwaEnabled = true;
    const app = await logout(new NextRequest(`${SITE}/host/auth/logout`, { method: "POST", headers: { ...sameOrigin, cookie: `${ACCOUNT_SESSION_COOKIE}=${SESSION_TOKEN}` } }));
    expect(app.headers.get("location")).toBe("/host/launch");
  });

  it("logout still clears the cookie when the store fails", async () => {
    store.revokeSession.mockRejectedValueOnce(new Error("db down"));
    const response = await logout(new NextRequest(`${SITE}/host/auth/logout`, { method: "POST", headers: { ...sameOrigin, cookie: `${ACCOUNT_SESSION_COOKIE}=${SESSION_TOKEN}` } }));
    expect(response.status).toBe(303);
    expect(setCookies(response).get(ACCOUNT_SESSION_COOKIE)!.attributes).toMatch(/Max-Age=0/);
  });

  it("refresh is a no-op success that tells the keeper the idle end, and 401 once the session ended", async () => {
    const response = await refresh(new NextRequest(`${SITE}/host/auth/refresh`, { method: "POST", headers: { ...sameOrigin, cookie: `${ACCOUNT_SESSION_COOKIE}=${SESSION_TOKEN}` } }));
    expect(response.status).toBe(200);
    const body = await response.json() as { refreshed: boolean; accessTokenExpiresAt: number };
    expect(body.refreshed).toBe(false);
    expect(Math.abs(body.accessTokenExpiresAt - (Date.now() + 14 * DAY))).toBeLessThan(5_000);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(store.readSession).toHaveBeenCalledWith(expect.objectContaining({ sessionToken: SESSION_TOKEN }));
    // Even inside the installed app: no refresh token can be spent twice.
    const inApp = await refresh(new NextRequest(`${SITE}/host/auth/refresh`, { method: "POST", headers: { ...sameOrigin, "x-niho-host-display": "standalone", cookie: `${ACCOUNT_SESSION_COOKIE}=${SESSION_TOKEN}` } }));
    expect(inApp.status).toBe(200);

    store.readSession.mockResolvedValueOnce(null);
    const ended = await refresh(new NextRequest(`${SITE}/host/auth/refresh`, { method: "POST", headers: { ...sameOrigin, cookie: `${ACCOUNT_SESSION_COOKIE}=${SESSION_TOKEN}` } }));
    expect(ended.status).toBe(401);
    expect(await ended.json()).toEqual({ error: "session_expired" });
    expect(setCookies(ended).get(ACCOUNT_SESSION_COOKIE)!.attributes).toMatch(/Max-Age=0/);
  });
});
