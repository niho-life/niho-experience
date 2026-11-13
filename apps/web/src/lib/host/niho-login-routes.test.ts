import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NihoSessionResult } from "@niho-experience/experience-store";

/**
 * 「NIHO アカウントでログイン」 (Epic #591, #594): the login start and the callback against a synthetic NIHO and a stubbed
 * store. NIHO only proves who the host is: the connection ends at once and no NIHO token reaches a cookie, a URL or the store.
 */
const state = vi.hoisted(() => ({
  config: {
    apiMode: "http",
    hostConsoleEnabled: true,
    hostAccountsEnabled: true,
    hostNihoLoginEnabled: true,
    hostPwaEnabled: false,
    hostPushEnabled: false,
    hostSessionSecret: "synthetic-route-test-secret-0123456789abcdef",
    nihoWebOrigin: "https://niho.example.test",
    nihoExperienceHostCommonContractAudience: "https://api.niho.example.test",
    siteUrl: "https://experience.example.test",
  },
  cookies: {} as Record<string, string>,
  identities: null as { startSessionForNihoIdentity: ReturnType<typeof import("vitest").vi.fn> } | null,
  accounts: null as { readSession: ReturnType<typeof import("vitest").vi.fn>; revokeSession: ReturnType<typeof import("vitest").vi.fn> } | null,
}));
vi.mock("server-only", () => ({}));
vi.mock("react", () => ({ cache: (read: unknown) => read }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (name: string) => (name in state.cookies ? { name, value: state.cookies[name] } : undefined) }) }));
vi.mock("google-auth-library", () => ({ GoogleAuth: class {
  async getIdTokenClient() { return { getRequestHeaders: async () => ({ authorization: "Bearer synthetic-service-id-token" }) }; }
} }));
vi.mock("@/lib/config", () => ({ config: state.config, isPreview: false }));
vi.mock("@/lib/experience/store-server", () => ({
  hostAccounts: () => state.accounts,
  hostAccountIdentities: () => state.identities,
  experiencePool: () => null,
}));

import { GET as login } from "@/app/(host)/host/auth/login/route";
import { GET as callback } from "@/app/(host)/host/auth/callback/route";
import { GET as mockLogin } from "@/app/(host)/host/auth/mock-login/route";
import { cookieSealer } from "./cookie-seal";
import { decodeLoginState, ACCOUNT_SESSION_COOKIE, LOGIN_COOKIE, SESSION_COOKIE } from "./session";

const SITE = state.config.siteUrl;
const NIHO = state.config.nihoWebOrigin;
const DAY = 86_400_000;
const HOST = `hst_${"c".repeat(32)}`;
const NIHO_USER = "niho-user-synthetic-1";
const ACCESS = "niho-access-token-synthetic";
const REFRESH = "niho-refresh-token-synthetic";
const CONNECTION = "conn_synthetic_1";
const SESSION_TOKEN = "sessionTokenOpened".padEnd(43, "x");
const OLD_SESSION_TOKEN = "oldSessionToken".padEnd(43, "x");
const INVITATION = "8f14e45f-ceea-467a-9575-1f2a3b4c5d6e";

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;
let handler: Handler;
const calls: { url: URL; init: RequestInit }[] = [];

beforeEach(() => {
  calls.length = 0;
  Object.assign(state.config, { hostConsoleEnabled: true, hostAccountsEnabled: true, hostNihoLoginEnabled: true, apiMode: "http" });
  state.cookies = {};
  state.identities = { startSessionForNihoIdentity: vi.fn(async (): Promise<NihoSessionResult> => ({ kind: "ok", sessionToken: SESSION_TOKEN, sessionRef: "0f8fad5b-d9cb-469f-a165-70867728950e", hostAccountId: HOST, absoluteExpiresAtUtc: new Date(Date.now() + 30 * DAY).toISOString() })) };
  state.accounts = { readSession: vi.fn(async () => null), revokeSession: vi.fn(async () => true) };
  handler = niho();
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    return handler(url, init);
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A NIHO that exchanges the code, answers `identity` for the access token and ends the connection. */
function niho(overrides: { exchange?: () => Response; identity?: () => Response; remove?: () => Response } = {}): Handler {
  return (url, init) => {
    if (url.pathname === "/api/auth/app-connect/exchange") {
      return overrides.exchange?.() ?? json(200, { accessToken: ACCESS, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), refreshToken: REFRESH, connectionId: CONNECTION, connectionExpiresAt: new Date(Date.now() + 90 * DAY).toISOString(), user: { displayName: "合成 ホスト", iconImage: null } });
    }
    if (url.pathname === "/api/experience-host/identity") {
      expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${ACCESS}`);
      expect((init.headers as Record<string, string>)["x-niho-experience-service-id-token"]).toBe("synthetic-service-id-token");
      return overrides.identity?.() ?? json(200, { nihoUserId: NIHO_USER, accountStatus: "ACTIVE" });
    }
    if (init.method === "DELETE" && url.pathname === `/api/auth/app-connections/${CONNECTION}`) return overrides.remove?.() ?? new Response(null, { status: 204 });
    return json(404, { error: "not_found" });
  };
}

function setCookies(response: Response): Map<string, { value: string; attributes: string }> {
  const cookies = new Map<string, { value: string; attributes: string }>();
  for (const header of response.headers.getSetCookie()) {
    const [pair = "", ...attributes] = header.split("; ");
    const index = pair.indexOf("=");
    cookies.set(pair.slice(0, index), { value: pair.slice(index + 1), attributes: attributes.join("; ") });
  }
  return cookies;
}

async function startLogin(query = "") {
  const response = await login(new NextRequest(`${SITE}/host/auth/login${query}`));
  const location = new URL(response.headers.get("location")!);
  const cookie = setCookies(response).get(LOGIN_COOKIE);
  return { response, location, cookie: cookie ? `${LOGIN_COOKIE}=${cookie.value}` : "", attributes: cookie?.attributes ?? "" };
}

/** The whole round trip: start, then NIHO returns with a code. */
async function signIn(query = "", cookieExtra = "") {
  const { location, cookie } = await startLogin(query);
  const response = await callback(new NextRequest(`${SITE}/host/auth/callback?code=code-1&state=${location.searchParams.get("state")}`, { headers: { cookie: [cookie, cookieExtra].filter(Boolean).join("; ") } }));
  return { response, location };
}

const deleteCalls = () => calls.filter((call) => call.init.method === "DELETE");

describe("starting the NIHO account login", () => {
  it("sends the host to NIHO's confirmation page for hosts, with a S256 challenge, and keeps the verifier in a sealed 10-minute cookie", async () => {
    const { response, location, cookie, attributes } = await startLogin();
    expect(response.status).toBe(303);
    expect(location.origin).toBe(NIHO);
    expect(location.pathname).toBe("/connect/niho-experience");
    expect(location.searchParams.get("v")).toBe("1");
    expect(location.searchParams.get("origin")).toBe(SITE);
    expect(location.searchParams.get("audience")).toBe("host");
    expect(location.searchParams.get("challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(location.searchParams.get("max_age")).toBeNull();
    expect(attributes).toMatch(/HttpOnly/);
    expect(attributes).toMatch(/Path=\/host\/auth/);
    expect(attributes).toMatch(/Max-Age=600/);
    const stored = decodeLoginState(cookieSealer(state.config.hostSessionSecret, "login"), cookie.slice(LOGIN_COOKIE.length + 1), Date.now());
    expect(stored?.state).toBe(location.searchParams.get("state"));
    // The email form is not where the login goes now.
    expect(response.headers.get("location")).not.toContain("/host/auth/sign-in");
  });

  it("keeps an invitation or an allowlisted page for the return, and nothing else", async () => {
    const invited = await startLogin(`?invitationId=${INVITATION}`);
    expect(decodeLoginState(cookieSealer(state.config.hostSessionSecret, "login"), invited.cookie.slice(LOGIN_COOKIE.length + 1), Date.now())).toMatchObject({ invitationId: INVITATION });
    const writing = await startLogin(`?returnTo=${encodeURIComponent("/write/new")}`);
    expect(decodeLoginState(cookieSealer(state.config.hostSessionSecret, "login"), writing.cookie.slice(LOGIN_COOKIE.length + 1), Date.now())).toMatchObject({ returnPath: "/write/new" });
    for (const returnTo of ["https://evil.example.test/write", "//evil.example.test", "/host/anything", "/write/a/b", "/admin"]) {
      const stored = decodeLoginState(cookieSealer(state.config.hostSessionSecret, "login"), (await startLogin(`?returnTo=${encodeURIComponent(returnTo)}`)).cookie.slice(LOGIN_COOKIE.length + 1), Date.now());
      expect(stored?.returnPath, returnTo).toBeUndefined();
    }
  });

  it("does not go to NIHO again for a host who is already signed in", async () => {
    state.cookies[ACCOUNT_SESSION_COOKIE] = SESSION_TOKEN;
    state.accounts!.readSession.mockResolvedValue({ hostAccountId: HOST, email: "synthetic-host@example.test", sessionRef: "0f8fad5b-d9cb-469f-a165-70867728950e", authenticatedAtUtc: new Date().toISOString(), idleExpiresAtUtc: new Date(Date.now() + DAY).toISOString(), absoluteExpiresAtUtc: new Date(Date.now() + 2 * DAY).toISOString() });
    const response = await login(new NextRequest(`${SITE}/host/auth/login?returnTo=${encodeURIComponent("/write")}`));
    expect(response.headers.get("location")).toBe("/write");
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("is the email form again while the flag is off, and NIHO's own login when host accounts are off", async () => {
    state.config.hostNihoLoginEnabled = false;
    expect((await login(new NextRequest(`${SITE}/host/auth/login`))).headers.get("location")).toBe("/host/auth/sign-in");
    expect((await callback(new NextRequest(`${SITE}/host/auth/callback?code=c&state=s`))).status).toBe(404);
    state.config.hostAccountsEnabled = false;
    expect(new URL((await login(new NextRequest(`${SITE}/host/auth/login`))).headers.get("location")!).origin).toBe(NIHO);
  });
});

describe("the callback", () => {
  it("opens the Experience session of the bound host account and ends the NIHO connection, keeping no NIHO token", async () => {
    const { response } = await signIn();
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/host/home");
    const cookies = setCookies(response);
    expect(cookies.get(ACCOUNT_SESSION_COOKIE)?.value).toBe(SESSION_TOKEN);
    expect(cookies.get(ACCOUNT_SESSION_COOKIE)?.attributes).toMatch(/HttpOnly/);
    expect(cookies.get(ACCOUNT_SESSION_COOKIE)?.attributes).toMatch(/Path=\//);
    // The login cookie is cleared; the NIHO session cookie (the former login) is never set.
    expect(cookies.get(LOGIN_COOKIE)?.attributes).toMatch(/Max-Age=0/);
    expect(cookies.has(SESSION_COOKIE)).toBe(false);

    // The store was asked with the NIHO user ID and the time of the sign-in, and nothing else of NIHO's.
    expect(state.identities!.startSessionForNihoIdentity).toHaveBeenCalledTimes(1);
    const asked = state.identities!.startSessionForNihoIdentity.mock.calls[0]![0] as { nihoUserId: string; authenticatedAtUtc: string; nowUtc: string };
    expect(Object.keys(asked).sort()).toEqual(["authenticatedAtUtc", "nihoUserId", "nowUtc"]);
    expect(asked.nihoUserId).toBe(NIHO_USER);
    expect(asked.authenticatedAtUtc).toBe(asked.nowUtc);

    // The connection ends right after the identity was read, with the connection's own token and no reason.
    expect(calls.map((call) => `${call.init.method ?? "GET"} ${call.url.pathname}`)).toEqual([
      "POST /api/auth/app-connect/exchange",
      "GET /api/experience-host/identity",
      `DELETE /api/auth/app-connections/${CONNECTION}`,
    ]);
    expect(deleteCalls()[0]!.url.search).toBe("");
    expect((deleteCalls()[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${ACCESS}`);

    // No NIHO token or user ID is anywhere in what the browser gets.
    const everything = [response.headers.get("location"), ...response.headers.getSetCookie()].join("\n");
    for (const secret of [ACCESS, REFRESH, CONNECTION, NIHO_USER]) expect(everything).not.toContain(secret);
  });

  it("returns to the page the sign-in was for: an invitation, /write, or the provider's home", async () => {
    expect((await signIn(`?invitationId=${INVITATION}`)).response.headers.get("location")).toBe(`/host/invitations/${INVITATION}`);
    expect((await signIn(`?returnTo=${encodeURIComponent("/write/new?experience=sample-walk")}`)).response.headers.get("location")).toBe("/write/new?experience=sample-walk");
    expect((await signIn("?providerId=p_1")).response.headers.get("location")).toBe("/host/home?providerId=p_1");
    expect((await signIn(`?returnTo=${encodeURIComponent("https://evil.example.test")}`)).response.headers.get("location")).toBe("/host/home");
  });

  it("ends the session this browser held before, with its push", async () => {
    state.accounts!.readSession.mockResolvedValue({ hostAccountId: HOST, email: "e@example.test", sessionRef: "1f8fad5b-d9cb-469f-a165-70867728950e", authenticatedAtUtc: new Date().toISOString(), idleExpiresAtUtc: new Date(Date.now() + DAY).toISOString(), absoluteExpiresAtUtc: new Date(Date.now() + 2 * DAY).toISOString() });
    await signIn("", `${ACCOUNT_SESSION_COOKIE}=${OLD_SESSION_TOKEN}`);
    expect(state.accounts!.revokeSession).toHaveBeenCalledWith(expect.objectContaining({ sessionToken: OLD_SESSION_TOKEN }));
  });

  it("tells a NIHO account nobody registered, changes nothing, and still ends the connection", async () => {
    state.identities!.startSessionForNihoIdentity.mockResolvedValue({ kind: "not-linked" });
    const { response } = await signIn(`?invitationId=${INVITATION}`);
    expect(response.headers.get("location")).toBe(`/host/auth/error?reason=unregistered&invitationId=${INVITATION}`);
    expect(setCookies(response).has(ACCOUNT_SESSION_COOKIE)).toBe(false);
    expect(setCookies(response).get(LOGIN_COOKIE)?.attributes).toMatch(/Max-Age=0/);
    expect(deleteCalls()).toHaveLength(1);
    expect(state.accounts!.revokeSession).not.toHaveBeenCalled();
  });

  it("tells a suspended host account apart", async () => {
    state.identities!.startSessionForNihoIdentity.mockResolvedValue({ kind: "account-suspended" });
    const { response } = await signIn();
    expect(response.headers.get("location")).toBe("/host/auth/error?reason=suspended");
    expect(deleteCalls()).toHaveLength(1);
  });

  it("treats an expired or refused code as rejected, with no identity read and no connection to end", async () => {
    handler = niho({ exchange: () => json(400, { error: { reason: "code_expired" } }) });
    const { response } = await signIn();
    expect(response.headers.get("location")).toBe("/host/auth/error?reason=rejected");
    expect(calls.map((call) => call.url.pathname)).toEqual(["/api/auth/app-connect/exchange"]);
    expect(state.identities!.startSessionForNihoIdentity).not.toHaveBeenCalled();
  });

  it("tells NIHO being away from a refusal, ending the connection whenever there is one", async () => {
    handler = niho({ exchange: () => json(503, {}) });
    expect((await signIn()).response.headers.get("location")).toBe("/host/auth/error?reason=unavailable");
    expect(deleteCalls()).toHaveLength(0);

    handler = niho({ identity: () => json(401, { error: "unauthorized" }) });
    expect((await signIn()).response.headers.get("location")).toBe("/host/auth/error?reason=rejected");
    expect(deleteCalls()).toHaveLength(1);

    calls.length = 0;
    handler = niho({ identity: () => json(503, {}) });
    expect((await signIn()).response.headers.get("location")).toBe("/host/auth/error?reason=unavailable");
    expect(deleteCalls()).toHaveLength(1);

    calls.length = 0;
    // An identity answer of an unknown shape (a status other than ACTIVE) is not trusted.
    handler = niho({ identity: () => json(200, { nihoUserId: NIHO_USER, accountStatus: "SUSPENDED" }) });
    expect((await signIn()).response.headers.get("location")).toBe("/host/auth/error?reason=unavailable");
    expect(deleteCalls()).toHaveLength(1);
    expect(state.identities!.startSessionForNihoIdentity).not.toHaveBeenCalled();
  });

  it("is not stopped by NIHO failing to end the connection, and says nothing of the store's failure but its name", async () => {
    handler = niho({ remove: () => json(500, {}) });
    expect((await signIn()).response.headers.get("location")).toBe("/host/home");

    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    state.identities!.startSessionForNihoIdentity.mockRejectedValue(new Error(`database said ${NIHO_USER} ${ACCESS}`));
    handler = niho();
    const { response } = await signIn();
    expect(response.headers.get("location")).toBe("/host/auth/error?reason=unavailable");
    expect(setCookies(response).has(ACCOUNT_SESSION_COOKIE)).toBe(false);
    expect(errors.mock.calls.flat().join(" ")).not.toMatch(new RegExp(`${NIHO_USER}|${ACCESS}`));
    expect(deleteCalls().length).toBeGreaterThan(0);
  });

  it("refuses a return with a wrong state, a denial, a missing code or no login cookie, without calling NIHO", async () => {
    const { location, cookie } = await startLogin();
    const at = (query: string, cookieValue = cookie) => callback(new NextRequest(`${SITE}/host/auth/callback?${query}`, { headers: { cookie: cookieValue } }));
    expect((await at("code=c&state=wrong")).headers.get("location")).toBe("/host/auth/error?reason=state");
    expect((await at(`error=access_denied&state=${location.searchParams.get("state")}`)).headers.get("location")).toBe("/host/auth/error?reason=denied");
    expect((await at(`state=${location.searchParams.get("state")}`)).headers.get("location")).toBe("/host/auth/error?reason=rejected");
    expect((await at(`code=${"x".repeat(3000)}&state=${location.searchParams.get("state")}`)).headers.get("location")).toBe("/host/auth/error?reason=rejected");
    expect((await at(`code=c&state=${location.searchParams.get("state")}`, "")).headers.get("location")).toBe("/host/auth/error?reason=expired");
    expect(calls).toEqual([]);
  });
});

describe("the preview (mock mode)", () => {
  it("shows the not-registered page for a synthetic NIHO account nobody registered, and signs the usual host in otherwise", async () => {
    state.config.apiMode = "mock";
    state.config.hostAccountsEnabled = false;
    const unregistered = await mockLogin(new NextRequest(`${SITE}/host/auth/mock-login?mock=unregistered`));
    expect(unregistered.headers.get("location")).toBe("/host/auth/error?reason=unregistered");
    expect(unregistered.headers.getSetCookie()).toEqual([]);
    const usual = await mockLogin(new NextRequest(`${SITE}/host/auth/mock-login`));
    expect(usual.headers.get("location")).toBe("/host/home");
    state.config.hostNihoLoginEnabled = false;
    const off = await mockLogin(new NextRequest(`${SITE}/host/auth/mock-login?mock=unregistered`));
    expect(off.headers.get("location")).toBe("/host/home");
  });
});
