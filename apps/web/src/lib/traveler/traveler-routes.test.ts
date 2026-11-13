import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TravelerSignInResult } from "@niho-experience/experience-store";

/**
 * 旅行者のアカウント (Epic #591, #597): the entrance, the way in through NIHO without NIHO's name, the return that opens the
 * traveler's own session, and logging out, against a synthetic NIHO and a stubbed store.
 */
const state = vi.hoisted(() => ({
  config: {
    apiMode: "http",
    hostConsoleEnabled: true,
    hostAccountsEnabled: true,
    hostNihoLoginEnabled: false,
    travelerAccountsEnabled: true,
    travelerLineEnabled: false,
    hostPwaEnabled: false,
    hostPushEnabled: false,
    hostSessionSecret: "synthetic-route-test-secret-0123456789abcdef",
    nihoWebOrigin: "https://niho.example.test",
    nihoExperienceHostCommonContractAudience: "https://api.niho.example.test",
    siteUrl: "https://experience.example.test",
    termsUrl: "",
  },
  cookies: {} as Record<string, string>,
  travelers: null as { signInWithNihoIdentity: ReturnType<typeof import("vitest").vi.fn>; readSession: ReturnType<typeof import("vitest").vi.fn>; revokeSession: ReturnType<typeof import("vitest").vi.fn> } | null,
  authTime: (): unknown => new Date().toISOString(),
  /** The runtime's service ID token cannot be issued. */
  serviceTokenFails: false,
}));
vi.mock("server-only", () => ({}));
vi.mock("react", async (importOriginal) => ({ ...(await importOriginal<typeof import("react")>()), cache: (read: unknown) => read }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (name: string) => (name in state.cookies ? { name, value: state.cookies[name] } : undefined) }) }));
vi.mock("next/navigation", () => ({
  notFound: () => { throw new Error("not-found"); },
  redirect: (to: string) => { throw new Error(`redirect:${to}`); },
}));
vi.mock("google-auth-library", () => ({ GoogleAuth: class {
  async getIdTokenClient() {
    if (state.serviceTokenFails) throw new Error("metadata server unavailable: synthetic-service-id-token");
    return { getRequestHeaders: async () => ({ authorization: "Bearer synthetic-service-id-token" }) };
  }
} }));
vi.mock("@/lib/config", () => ({ config: state.config, isPreview: false }));
vi.mock("@/lib/experience/store-server", () => ({
  travelerAccounts: () => state.travelers,
  hostAccounts: () => null,
  hostAccountIdentities: () => null,
  hostInvitations: () => null,
  experiencePool: () => null,
}));

import { POST as start } from "@/app/(site)/account/auth/start/route";
import { POST as logout } from "@/app/(site)/account/auth/logout/route";
import { GET as mockLogin } from "@/app/(site)/account/auth/mock-login/route";
import { GET as callback } from "@/app/(host)/host/auth/callback/route";
import TravelerSignInPage from "@/app/(site)/account/sign-in/page";
import TravelerAccountPage from "@/app/(site)/account/page";
import { cookieSealer } from "@/lib/host/cookie-seal";
import { ACCOUNT_SESSION_COOKIE, decodeLoginState, LOGIN_COOKIE, SESSION_COOKIE } from "@/lib/host/session";
import { MOCK_TRAVELER_SESSION, TRAVELER_LOGIN_HINT_COOKIE, TRAVELER_SESSION_COOKIE } from "./session";

const SITE = state.config.siteUrl;
const DAY = 86_400_000;
const NIHO_USER = "niho-user-synthetic-traveler";
const ACCESS = "niho-access-token-traveler";
const REFRESH = "niho-refresh-token-traveler";
const CONNECTION = "conn_synthetic_traveler";
const TRAVELER = `trv_${"a".repeat(32)}`;
const SESSION_TOKEN = "travelerSessionToken".padEnd(43, "x");
const OLD_TOKEN = "oldTravelerSessionToken".padEnd(43, "x");
const sameOrigin = { origin: SITE, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" };

const calls: { url: URL; init: RequestInit }[] = [];
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  calls.length = 0;
  Object.assign(state.config, { apiMode: "http", hostConsoleEnabled: true, hostAccountsEnabled: true, hostNihoLoginEnabled: false, travelerAccountsEnabled: true, travelerLineEnabled: false, termsUrl: "" });
  state.cookies = {};
  state.authTime = () => new Date().toISOString();
  state.serviceTokenFails = false;
  state.travelers = {
    signInWithNihoIdentity: vi.fn(async (): Promise<TravelerSignInResult> => ({ kind: "ok", sessionToken: SESSION_TOKEN, sessionRef: "0f8fad5b-d9cb-469f-a165-70867728950e", travelerAccountId: TRAVELER, absoluteExpiresAtUtc: new Date(Date.now() + 30 * DAY).toISOString(), created: true })),
    readSession: vi.fn(async () => null),
    revokeSession: vi.fn(async () => true),
  };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    if (url.pathname === "/api/auth/app-connect/exchange") return json(200, { accessToken: ACCESS, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), refreshToken: REFRESH, connectionId: CONNECTION, connectionExpiresAt: new Date(Date.now() + 90 * DAY).toISOString(), user: { displayName: "合成", iconImage: null }, authTime: state.authTime() });
    if (url.pathname === "/api/experience-host/identity") return json(200, { nihoUserId: NIHO_USER, accountStatus: "ACTIVE" });
    if (init.method === "DELETE") return new Response(null, { status: 204 });
    return json(404, {});
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const post = (path: string, body: string, headers: Record<string, string> = sameOrigin, cookie = "") => new NextRequest(`${SITE}${path}`, { method: "POST", headers: { ...headers, ...(cookie ? { cookie } : {}) }, body });
const location = (response: Response) => response.headers.get("location")!;
const setCookies = (response: Response) => new Map(response.headers.getSetCookie().map((header) => {
  const [pair = "", ...attributes] = header.split("; ");
  const index = pair.indexOf("=");
  return [pair.slice(0, index), { value: pair.slice(index + 1), attributes: attributes.join("; ") }] as const;
}));
const loginStateOf = (response: Response) => decodeLoginState(cookieSealer(state.config.hostSessionSecret, "login"), setCookies(response).get(LOGIN_COOKIE)!.value, Date.now());

describe("a traveler's way in", () => {
  it("goes through NIHO as a guest, straight to the provider the traveler pressed, with a sealed state and no step-up", async () => {
    const response = await start(post("/account/auth/start", "method=google"));
    expect(response.status).toBe(303);
    const to = new URL(location(response));
    expect(to.origin).toBe("https://niho.example.test");
    expect(to.pathname).toBe("/connect/niho-experience");
    expect(to.searchParams.get("audience")).toBe("guest");
    expect(to.searchParams.get("method")).toBe("google");
    expect(to.searchParams.get("max_age")).toBeNull();
    expect(to.searchParams.get("origin")).toBe(SITE);
    expect(to.searchParams.get("challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(loginStateOf(response)).toMatchObject({ purpose: "traveler", providerId: null });
    // The hint beside it only tells where a return with no state goes.
    expect(setCookies(response).get(TRAVELER_LOGIN_HINT_COOKIE)?.attributes).toMatch(/Path=\/host\/auth/);
    // Apple is understood (NIHO may offer it later) though the entrance does not offer it.
    expect(new URL(location(await start(post("/account/auth/start", "method=apple")))).searchParams.get("method")).toBe("apple");
  });

  it("takes LINE only once its flag is on: until then a post for it is refused like a method nobody offers", async () => {
    // Off by default (NIHO's LINE provider moves in 2027-01; see EXPERIENCE_TRAVELER_LINE_ENABLED).
    const refused = await start(post("/account/auth/start", "method=line"));
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: "invalid_input" });
    expect(refused.headers.getSetCookie()).toEqual([]);
    expect((await start(post("/account/auth/start", "method=facebook"))).status).toBe(400);
    state.config.travelerLineEnabled = true;
    const accepted = await start(post("/account/auth/start", "method=line"));
    expect(accepted.status).toBe(303);
    expect(new URL(location(accepted)).searchParams.get("method")).toBe("line");
    expect(loginStateOf(accepted)).toMatchObject({ purpose: "traveler" });
  });

  it("is NIHO's own login screen for someone who already has a NIHO account (no method)", async () => {
    const to = new URL(location(await start(post("/account/auth/start", ""))));
    expect(to.searchParams.get("audience")).toBe("guest");
    expect(to.searchParams.has("method")).toBe(false);
  });

  it("refuses a cross-site post, a method it does not know, a wrong form and a switched-off flag, and sends a logged-in traveler to their account", async () => {
    expect((await start(post("/account/auth/start", "method=google", { ...sameOrigin, origin: "https://evil.example.test", "sec-fetch-site": "cross-site" }))).status).toBe(403);
    expect((await start(post("/account/auth/start", "method=facebook"))).status).toBe(400);
    expect((await start(post("/account/auth/start", "method=google&x=1"))).status).toBe(400);
    state.cookies[TRAVELER_SESSION_COOKIE] = SESSION_TOKEN;
    state.travelers!.readSession.mockResolvedValue({ travelerAccountId: TRAVELER, sessionRef: "0f8fad5b-d9cb-469f-a165-70867728950e", authenticatedAtUtc: new Date().toISOString(), idleExpiresAtUtc: "", absoluteExpiresAtUtc: "" });
    expect(location(await start(post("/account/auth/start", "method=google")))).toBe("/account");
    state.config.travelerAccountsEnabled = false;
    expect((await start(post("/account/auth/start", "method=google"))).status).toBe(404);
  });

  it("walks the preview's synthetic traveler in mock mode", async () => {
    state.config.apiMode = "mock";
    expect(location(await start(post("/account/auth/start", "method=google")))).toBe("/account/auth/mock-login");
    const response = await mockLogin();
    expect(location(response)).toBe("/account");
    expect(setCookies(response).get(TRAVELER_SESSION_COOKIE)?.value).toBe(MOCK_TRAVELER_SESSION);
    state.config.apiMode = "http";
    expect((await mockLogin()).status).toBe(404);
  });
});

describe("the return of a traveler's log in", () => {
  async function comeBack(extra = "", cookies: Record<string, string> = {}) {
    const started = await start(post("/account/auth/start", "method=google"));
    const stateValue = new URL(location(started)).searchParams.get("state");
    const jar = { [LOGIN_COOKIE]: setCookies(started).get(LOGIN_COOKIE)!.value, [TRAVELER_LOGIN_HINT_COOKIE]: "1", ...cookies };
    return callback(new NextRequest(`${SITE}/host/auth/callback?code=code-1&state=${stateValue}${extra}`, { headers: { cookie: Object.entries(jar).map(([name, value]) => `${name}=${value}`).join("; ") } }));
  }

  it("opens the traveler's own account and session in their own cookie, never a host's, and ends the NIHO connection", async () => {
    const response = await comeBack();
    expect(response.status).toBe(303);
    expect(location(response)).toBe("/account");
    const cookies = setCookies(response);
    expect(cookies.get(TRAVELER_SESSION_COOKIE)?.value).toBe(SESSION_TOKEN);
    expect(cookies.get(TRAVELER_SESSION_COOKIE)?.attributes).toMatch(/HttpOnly/);
    expect(cookies.get(TRAVELER_SESSION_COOKIE)?.attributes).toMatch(/Path=\//);
    expect(cookies.get(LOGIN_COOKIE)?.attributes).toMatch(/Max-Age=0/);
    expect(cookies.get(TRAVELER_LOGIN_HINT_COOKIE)?.attributes).toMatch(/Max-Age=0/);
    // Not a host session, in either cookie the console reads.
    expect(cookies.has(ACCOUNT_SESSION_COOKIE)).toBe(false);
    expect(cookies.has(SESSION_COOKIE)).toBe(false);
    expect(state.travelers!.signInWithNihoIdentity).toHaveBeenCalledWith({ nihoUserId: NIHO_USER, authenticatedAtUtc: expect.any(String), nowUtc: expect.any(String) });
    expect(calls.map((call) => `${call.init.method ?? "GET"} ${call.url.pathname}`)).toEqual([
      "POST /api/auth/app-connect/exchange", "GET /api/experience-host/identity", `DELETE /api/auth/app-connections/${CONNECTION}`,
    ]);
    expect([location(response), ...response.headers.getSetCookie()].join("\n")).not.toMatch(new RegExp(`${NIHO_USER}|${ACCESS}|${REFRESH}|${CONNECTION}`));
  });

  it("counts the NIHO calls against the Experience service: the service ID token goes on the exchange, the identity call and the connection's end", async () => {
    await comeBack();
    const header = (index: number) => (calls[index]!.init.headers as Record<string, string>)["x-niho-experience-service-id-token"];
    expect(calls.map((call, index) => `${call.init.method ?? "GET"} ${call.url.pathname} ${header(index)}`)).toEqual([
      "POST /api/auth/app-connect/exchange synthetic-service-id-token",
      "GET /api/experience-host/identity synthetic-service-id-token",
      `DELETE /api/auth/app-connections/${CONNECTION} synthetic-service-id-token`,
    ]);
  });

  it("does not stop a log in when the token cannot be issued: the exchange and the end go without it (NIHO counts them by IP), and the log says so without the token", async () => {
    state.serviceTokenFails = true;
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await comeBack();
    // The identity call needs the service identity (it is the server-to-server contract), so this log in does not finish; the
    // exchange and the connection's end still went without the header.
    expect(location(response)).toBe("/account/sign-in?error=unavailable");
    const exchange = calls.find((call) => call.url.pathname === "/api/auth/app-connect/exchange")!;
    expect(JSON.stringify(exchange.init.headers)).not.toContain("service-id-token");
    const end = calls.find((call) => call.init.method === "DELETE")!;
    expect(JSON.stringify(end.init.headers)).not.toContain("service-id-token");
    expect(errors.mock.calls.flat().join(" ")).toContain("service ID token not issued");
    expect(errors.mock.calls.flat().join(" ")).not.toContain("synthetic-service-id-token");
  });

  it("takes the time the traveler signed in at NIHO (authTime), and opens nothing without it", async () => {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60_000).toISOString();
    state.authTime = () => tenMinutesAgo;
    await comeBack();
    expect(state.travelers!.signInWithNihoIdentity).toHaveBeenLastCalledWith(expect.objectContaining({ authenticatedAtUtc: tenMinutesAgo }));
    for (const missing of [undefined, null, "not a time"]) {
      state.travelers!.signInWithNihoIdentity.mockClear();
      calls.length = 0;
      state.authTime = () => missing;
      const response = await comeBack();
      expect(location(response), String(missing)).toBe("/account/sign-in?error=unavailable");
      expect(setCookies(response).has(TRAVELER_SESSION_COOKIE)).toBe(false);
      expect(state.travelers!.signInWithNihoIdentity).not.toHaveBeenCalled();
      expect(calls.filter((call) => call.init.method === "DELETE")).toHaveLength(1);
    }
  });

  it("ends the session this browser held before", async () => {
    await comeBack("", { [TRAVELER_SESSION_COOKIE]: OLD_TOKEN });
    expect(state.travelers!.revokeSession).toHaveBeenCalledWith(expect.objectContaining({ sessionToken: OLD_TOKEN }));
  });

  it("tells a suspended account, a refused code, a denial and an outage on the traveler's own English page", async () => {
    state.travelers!.signInWithNihoIdentity.mockResolvedValueOnce({ kind: "account-suspended" });
    expect(location(await comeBack())).toBe("/account/sign-in?error=suspended");
    state.travelers!.signInWithNihoIdentity.mockRejectedValueOnce(new Error(`database said ${NIHO_USER} ${ACCESS}`));
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(location(await comeBack())).toBe("/account/sign-in?error=unavailable");
    expect(errors.mock.calls.flat().join(" ")).not.toMatch(new RegExp(`${NIHO_USER}|${ACCESS}`));
    expect(location(await comeBack("&error=access_denied"))).toBe("/account/sign-in?error=denied");
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      calls.push({ url: new URL(String(input)), init });
      return json(400, { error: { reason: "code_expired" } });
    }));
    expect(location(await comeBack())).toBe("/account/sign-in?error=expired");
  });

  it("sends a return whose sealed state is gone to the traveler's page, not the host console's", async () => {
    const stateless = (cookie: string) => callback(new NextRequest(`${SITE}/host/auth/callback?code=c&state=s`, { headers: cookie ? { cookie } : {} }));
    expect(location(await stateless(`${TRAVELER_LOGIN_HINT_COOKIE}=1`))).toBe("/account/sign-in?error=expired");
    expect(location(await stateless(""))).toBe("/host/auth/error?reason=expired");
    expect(calls).toEqual([]);
  });

  it("does not take a traveler's return for a host's, and a host's return is a 404 while the NIHO login is off", async () => {
    // A traveler's state with the traveler flag off: a 404, nothing opened.
    const started = await start(post("/account/auth/start", "method=google"));
    const stateValue = new URL(location(started)).searchParams.get("state");
    state.config.travelerAccountsEnabled = false;
    const gone = await callback(new NextRequest(`${SITE}/host/auth/callback?code=c&state=${stateValue}`, { headers: { cookie: `${LOGIN_COOKIE}=${setCookies(started).get(LOGIN_COOKIE)!.value}` } }));
    expect(gone.status).toBe(404);
    // With the traveler flag on and the host NIHO login off, a host-purpose return is a 404 too.
    state.config.travelerAccountsEnabled = true;
    const hostState = await callback(new NextRequest(`${SITE}/host/auth/callback?code=c&state=s`, { headers: { cookie: "" } }));
    expect(hostState.status).toBe(303);
    expect(state.travelers!.signInWithNihoIdentity).not.toHaveBeenCalled();
  });
});

describe("logging out", () => {
  it("ends the session at the server and clears the cookie, whatever the server said", async () => {
    const response = await logout(post("/account/auth/logout", "", sameOrigin, `${TRAVELER_SESSION_COOKIE}=${SESSION_TOKEN}`));
    expect(location(response)).toBe("/account/sign-in");
    expect(state.travelers!.revokeSession).toHaveBeenCalledWith(expect.objectContaining({ sessionToken: SESSION_TOKEN }));
    expect(setCookies(response).get(TRAVELER_SESSION_COOKIE)?.attributes).toMatch(/Max-Age=0/);
    state.travelers!.revokeSession.mockRejectedValueOnce(new Error("boom"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(setCookies(await logout(post("/account/auth/logout", "", sameOrigin, `${TRAVELER_SESSION_COOKIE}=${SESSION_TOKEN}`))).get(TRAVELER_SESSION_COOKIE)?.attributes).toMatch(/Max-Age=0/);
    expect((await logout(post("/account/auth/logout", "", { ...sameOrigin, origin: "https://evil.example.test", "sec-fetch-site": "cross-site" }))).status).toBe(403);
    state.config.travelerAccountsEnabled = false;
    expect((await logout(post("/account/auth/logout", ""))).status).toBe(404);
  });
});

describe("the traveler's pages", () => {
  const entrance = async (query: Record<string, string> = {}) => renderToStaticMarkup(await TravelerSignInPage({ searchParams: Promise.resolve(query) }));

  it("is a heading, a button for each way in (Google; LINE only once its flag is on), one sentence of consent, and last and small the NIHO account's way in", async () => {
    const html = await entrance();
    expect(html).toContain("Log in or sign up");
    expect(html).toContain('action="/account/auth/start"');
    expect(html).toMatch(/<button[^>]*value="google"[^>]*name="method"[^>]*>Continue with Google<\/button>/);
    // LINE waits for the move of NIHO's LINE provider (EXPERIENCE_TRAVELER_LINE_ENABLED): no button, no value to post.
    expect(html).not.toContain("LINE");
    expect(html).not.toContain('value="line"');
    // Apple has no web sign-in at NIHO yet: not offered, so no traveler is dropped into NIHO's usual screen.
    expect(html).not.toContain("Apple");
    expect(html).toContain("By continuing, you agree to our");
    expect(html).toContain('href="/privacy"');
    expect(html).not.toContain("Terms of Service");
    expect(html).toContain("You can still book as a guest without an account.");
    // NIHO appears only in the last small button; no "connect" anywhere.
    expect(html.match(/NIHO/g)).toHaveLength(1);
    expect(html).toContain("Log in with a NIHO account");
    expect(html.indexOf("Log in with a NIHO account")).toBeGreaterThan(html.indexOf("Continue with Google"));
    expect(html).not.toMatch(/connect/i);
    state.config.termsUrl = "https://terms.example.test/traveler";
    expect(await entrance()).toContain('<a href="https://terms.example.test/traveler" class="font-bold underline underline-offset-4">Terms of Service</a>');
    state.config.termsUrl = "";
    // With the flag on LINE follows Google, above the NIHO account's way in.
    state.config.travelerLineEnabled = true;
    const withLine = await entrance();
    expect(withLine).toMatch(/<button[^>]*value="line"[^>]*name="method"[^>]*>Continue with LINE<\/button>/);
    expect(withLine.indexOf("Continue with LINE")).toBeGreaterThan(withLine.indexOf("Continue with Google"));
    expect(withLine.indexOf("Log in with a NIHO account")).toBeGreaterThan(withLine.indexOf("Continue with LINE"));
    expect(withLine.match(/NIHO/g)).toHaveLength(1);
  });

  it("tells why a log in did not finish in words that name nobody and no other service, and nothing for an unknown value", async () => {
    for (const error of ["expired", "denied", "unavailable", "suspended"]) {
      const html = await entrance({ error });
      expect(html, error).toContain('role="alert"');
      expect(html.match(/NIHO/g), error).toHaveLength(1);
    }
    expect(await entrance({ error: "<script>" })).not.toContain('role="alert"');
  });

  it("sends a logged-in traveler to their account, and the account page asks for a log in first", async () => {
    state.cookies[TRAVELER_SESSION_COOKIE] = SESSION_TOKEN;
    state.travelers!.readSession.mockResolvedValue({ travelerAccountId: TRAVELER, sessionRef: "0f8fad5b-d9cb-469f-a165-70867728950e", authenticatedAtUtc: new Date().toISOString(), idleExpiresAtUtc: "", absoluteExpiresAtUtc: "" });
    await expect(entrance()).rejects.toThrow("redirect:/account");
    const html = renderToStaticMarkup(await TravelerAccountPage());
    expect(html).toContain("You’re logged in.");
    expect(html).toContain('action="/account/auth/logout"');
    expect(html).not.toMatch(/NIHO|connect/i);
    state.travelers!.readSession.mockResolvedValue(null);
    await expect(TravelerAccountPage()).rejects.toThrow("redirect:/account/sign-in");
    state.config.travelerAccountsEnabled = false;
    await expect(entrance()).rejects.toThrow("not-found");
    await expect(TravelerAccountPage()).rejects.toThrow("not-found");
  });
});
