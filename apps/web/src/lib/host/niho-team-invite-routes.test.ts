import { createHash } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AcceptHostTeamInvitationResult, NihoSessionResult, OpenHostTeamInvitationResult } from "@niho-experience/experience-store";

/**
 * メンバーの招待 (#636): the page the email's link opens, the sign-in that follows, and the return that joins the person to the
 * team, against a synthetic NIHO and a stubbed store.
 */
const state = vi.hoisted(() => ({
  config: {
    apiMode: "http",
    hostConsoleEnabled: true,
    hostAccountsEnabled: true,
    hostNihoLoginEnabled: true,
    hostTeamInvitationsEnabled: true,
    hostPwaEnabled: false,
    hostPushEnabled: false,
    hostSessionSecret: "synthetic-route-test-secret-0123456789abcdef",
    nihoWebOrigin: "https://niho.example.test",
    nihoExperienceHostCommonContractAudience: "https://api.niho.example.test",
    siteUrl: "https://experience.example.test",
  },
  cookies: {} as Record<string, string>,
  invitations: null as { open: ReturnType<typeof import("vitest").vi.fn>; accept: ReturnType<typeof import("vitest").vi.fn> } | null,
  identities: null as { startSessionForNihoIdentity: ReturnType<typeof import("vitest").vi.fn> } | null,
  accounts: null as { readSession: ReturnType<typeof import("vitest").vi.fn>; revokeSession: ReturnType<typeof import("vitest").vi.fn> } | null,
}));
vi.mock("server-only", () => ({}));
vi.mock("react", async (importOriginal) => ({ ...(await importOriginal<typeof import("react")>()), cache: (read: unknown) => read }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (name: string) => (name in state.cookies ? { name, value: state.cookies[name] } : undefined) }) }));
vi.mock("google-auth-library", () => ({ GoogleAuth: class {
  async getIdTokenClient() { return { getRequestHeaders: async () => ({ authorization: "Bearer synthetic-service-id-token" }) }; }
} }));
vi.mock("@/lib/config", () => ({ config: state.config, isPreview: false }));
vi.mock("@/lib/experience/store-server", () => ({
  hostAccounts: () => state.accounts,
  hostAccountIdentities: () => state.identities,
  hostInvitations: () => null,
  hostTeamInvitations: () => state.invitations,
  experiencePool: () => null,
}));
vi.mock("@/components/host/HostAppWindow", () => ({ HostLoginLink: ({ href, children }: { href: string; children: unknown }) => ({ type: "a", props: { href, children }, key: null, $$typeof: Symbol.for("react.transitional.element") }) }));

import { GET as invitePage, POST as inviteOpen } from "@/app/(host)/host/auth/team-invite/route";
import { GET as login } from "@/app/(host)/host/auth/login/route";
import { GET as callback } from "@/app/(host)/host/auth/callback/route";
import HostLoginErrorPage from "@/app/(host)/host/auth/error/page";
import { cookieSealer } from "./cookie-seal";
import { ACCOUNT_SESSION_COOKIE, decodeLoginState, INVITE_BINDING_COOKIE, LOGIN_COOKIE, TEAM_INVITE_BINDING_COOKIE } from "./session";

const SITE = state.config.siteUrl;
const DAY = 86_400_000;
const HOST = `hst_${"e".repeat(32)}`;
const PROVIDER = "provider-synthetic-team";
const NIHO_USER = "niho-user-synthetic-team-invited";
const ACCESS = "niho-access-token-team-invite";
const CONNECTION = "conn_synthetic_team_invite";
const TOKEN = "teamInviteLinkToken".padEnd(43, "x");
const BINDING = "teamInviteBindingValue".padEnd(43, "y");
const SESSION_TOKEN = "sessionTokenTeamInvited".padEnd(43, "x");
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest();
const sameOrigin = { origin: SITE, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" };

const calls: { url: URL; init: RequestInit }[] = [];
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  calls.length = 0;
  Object.assign(state.config, { hostConsoleEnabled: true, hostAccountsEnabled: true, hostNihoLoginEnabled: true, hostTeamInvitationsEnabled: true, apiMode: "http" });
  state.cookies = { [TEAM_INVITE_BINDING_COOKIE]: BINDING };
  state.invitations = {
    open: vi.fn(async (): Promise<OpenHostTeamInvitationResult> => ({ kind: "opened" })),
    accept: vi.fn(async (): Promise<AcceptHostTeamInvitationResult> => ({ kind: "accepted", hostAccountId: HOST, providerId: PROVIDER, joined: true })),
  };
  state.identities = { startSessionForNihoIdentity: vi.fn(async (): Promise<NihoSessionResult> => ({ kind: "ok", sessionToken: SESSION_TOKEN, sessionRef: "0f8fad5b-d9cb-469f-a165-70867728950e", hostAccountId: HOST, absoluteExpiresAtUtc: new Date(Date.now() + 30 * DAY).toISOString() })) };
  state.accounts = { readSession: vi.fn(async () => null), revokeSession: vi.fn(async () => true) };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    if (url.pathname === "/api/auth/app-connect/exchange") return json(200, { accessToken: ACCESS, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), refreshToken: "refresh-team", connectionId: CONNECTION, connectionExpiresAt: new Date(Date.now() + 90 * DAY).toISOString(), user: { displayName: "合成", iconImage: null }, authTime: new Date().toISOString() });
    if (url.pathname === "/api/experience-host/identity") return json(200, { nihoUserId: NIHO_USER, accountStatus: "ACTIVE" });
    if (init.method === "DELETE") return new Response(null, { status: 204 });
    return json(404, {});
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const post = (body: string, headers: Record<string, string> = sameOrigin, cookie = "") => new NextRequest(`${SITE}/host/auth/team-invite`, { method: "POST", headers: { ...headers, ...(cookie ? { cookie } : {}) }, body });
const location = (response: Response) => response.headers.get("location")!;
const setCookies = (response: Response) => new Map(response.headers.getSetCookie().map((header) => {
  const [pair = "", ...attributes] = header.split("; ");
  const index = pair.indexOf("=");
  return [pair.slice(0, index), { value: pair.slice(index + 1), attributes: attributes.join("; ") }] as const;
}));

describe("the page the team invitation email opens", () => {
  it("is a no-store, no-referrer page whose script reads the token from the fragment and posts it to its own path", async () => {
    const response = invitePage();
    expect(response.status).toBe(200);
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cache-control")).toContain("no-store");
    const html = await response.text();
    expect(html).toContain("メンバーへの招待");
    expect(html).toContain("location.hash");
    expect(html).toContain("history.replaceState");
    expect(html).toContain('"/host/auth/team-invite"');
    expect(html).toContain('"/host/auth/login?teaminvite=1"');
    for (const reason of ["team-invite-expired", "team-invite-used", "team-invite-browser", "team-invite-invalid"]) expect(html).toContain(reason);
  });

  it("is a 404 while the flag is off, for the page and for the post", async () => {
    state.config.hostTeamInvitationsEnabled = false;
    expect(invitePage().status).toBe(404);
    expect((await inviteOpen(post(`t=${TOKEN}`))).status).toBe(404);
    expect(state.invitations!.open).not.toHaveBeenCalled();
  });
});

describe("opening the team invitation", () => {
  it("binds the invitation to this browser with its own cookie: random, HttpOnly, on the auth path for seven days", async () => {
    const response = await inviteOpen(post(`t=${TOKEN}`));
    expect(response.status).toBe(204);
    const cookies = setCookies(response);
    expect(cookies.has(INVITE_BINDING_COOKIE)).toBe(false);
    const cookie = cookies.get(TEAM_INVITE_BINDING_COOKIE)!;
    expect(cookie.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cookie.attributes).toMatch(/HttpOnly/);
    expect(cookie.attributes).toMatch(/Secure/);
    expect(cookie.attributes).toMatch(/SameSite=lax/i);
    expect(cookie.attributes).toMatch(/Path=\/host\/auth/);
    expect(cookie.attributes).toMatch(/Max-Age=604800/);
    expect(state.invitations!.open).toHaveBeenCalledWith({ token: TOKEN, browserBindingHash: sha256(cookie.value), nowUtc: expect.any(String) });
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("keeps the browser's own cookie when it opens again, and uses a new value when its own is taken", async () => {
    const again = await inviteOpen(post(`t=${TOKEN}`, sameOrigin, `${TEAM_INVITE_BINDING_COOKIE}=${BINDING}`));
    expect(setCookies(again).get(TEAM_INVITE_BINDING_COOKIE)?.value).toBe(BINDING);
    state.invitations!.open.mockResolvedValueOnce({ kind: "binding-in-use" });
    const taken = await inviteOpen(post(`t=${TOKEN}`, sameOrigin, `${TEAM_INVITE_BINDING_COOKIE}=${BINDING}`));
    expect(taken.status).toBe(204);
    expect(setCookies(taken).get(TEAM_INVITE_BINDING_COOKIE)!.value).not.toBe(BINDING);
  });

  it("tells why a link cannot be used, in the team invitation's reasons, and sets no cookie", async () => {
    const reasons: [OpenHostTeamInvitationResult, string][] = [
      [{ kind: "expired" }, "team-invite-expired"], [{ kind: "used" }, "team-invite-used"], [{ kind: "other-browser" }, "team-invite-browser"], [{ kind: "invalid" }, "team-invite-invalid"],
    ];
    for (const [result, reason] of reasons) {
      state.invitations!.open.mockResolvedValueOnce(result);
      const response = await inviteOpen(post(`t=${TOKEN}`));
      expect(response.status, reason).toBe(400);
      expect(await response.json()).toEqual({ reason });
      expect(response.headers.getSetCookie()).toEqual([]);
    }
  });

  it("refuses a cross-site post, a wrong body and a short token, and a store failure is a 503 that names nothing", async () => {
    expect((await inviteOpen(post(`t=${TOKEN}`, { ...sameOrigin, origin: "https://evil.example.test", "sec-fetch-site": "cross-site" }))).status).toBe(403);
    expect((await inviteOpen(post(`t=${TOKEN}&x=1`))).status).toBe(400);
    expect((await inviteOpen(post("t=short"))).status).toBe(400);
    expect(state.invitations!.open).not.toHaveBeenCalled();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    state.invitations!.open.mockRejectedValueOnce(new Error(`database said ${TOKEN}`));
    expect((await inviteOpen(post(`t=${TOKEN}`))).status).toBe(503);
    expect(errors.mock.calls.flat().join(" ")).not.toContain(TOKEN);
  });
});

describe("the NIHO sign-in of a team invitation", () => {
  const startUrl = `${SITE}/host/auth/login?teaminvite=1`;
  async function comeBack(cookieAtReturn: Record<string, string> | null = { [TEAM_INVITE_BINDING_COOKIE]: BINDING }, search = "") {
    const started = await login(new NextRequest(startUrl, { headers: { cookie: `${TEAM_INVITE_BINDING_COOKIE}=${BINDING}` } }));
    const stateValue = new URL(location(started)).searchParams.get("state");
    const loginCookie = started.headers.getSetCookie().find((entry) => entry.startsWith(`${LOGIN_COOKIE}=`))!.split(";")[0]!;
    const cookie = [loginCookie, ...Object.entries(cookieAtReturn ?? {}).map(([name, value]) => `${name}=${value}`)].join("; ");
    return callback(new NextRequest(`${SITE}/host/auth/callback?code=code-1&state=${stateValue}${search}`, { headers: { cookie } }));
  }

  it("starts at NIHO only for a browser that opened a team invitation, sealing the purpose", async () => {
    expect(location(await login(new NextRequest(startUrl)))).toBe("/host/auth/error?reason=team-invite-invalid");
    // A host invitation's cookie is not a team invitation's.
    expect(location(await login(new NextRequest(startUrl, { headers: { cookie: `${INVITE_BINDING_COOKIE}=${BINDING}` } })))).toBe("/host/auth/error?reason=team-invite-invalid");
    const started = await login(new NextRequest(startUrl, { headers: { cookie: `${TEAM_INVITE_BINDING_COOKIE}=${BINDING}` } }));
    const to = new URL(location(started));
    expect(to.origin).toBe("https://niho.example.test");
    expect(to.searchParams.get("audience")).toBe("host");
    const header = started.headers.getSetCookie().find((entry) => entry.startsWith(`${LOGIN_COOKIE}=`))!;
    expect(decodeLoginState(cookieSealer(state.config.hostSessionSecret, "login"), header.split(";")[0]!.slice(LOGIN_COOKIE.length + 1), Date.now())).toMatchObject({ purpose: "team-invite" });
  });

  it("is an ordinary sign-in when the flag is off: the parameter means nothing", async () => {
    state.config.hostTeamInvitationsEnabled = false;
    const started = await login(new NextRequest(startUrl, { headers: { cookie: `${TEAM_INVITE_BINDING_COOKIE}=${BINDING}` } }));
    const header = started.headers.getSetCookie().find((entry) => entry.startsWith(`${LOGIN_COOKIE}=`))!;
    expect(decodeLoginState(cookieSealer(state.config.hostSessionSecret, "login"), header.split(";")[0]!.slice(LOGIN_COOKIE.length + 1), Date.now())?.purpose).toBeUndefined();
  });

  it("joins the NIHO account to the team, opens the session at the provider's home and clears the invitation's cookie", async () => {
    const response = await comeBack();
    expect(location(response)).toBe(`/host/home?providerId=${PROVIDER}`);
    expect(state.invitations!.accept).toHaveBeenCalledWith({ browserBindingHash: sha256(BINDING), nihoUserId: NIHO_USER, nowUtc: expect.any(String) });
    expect(state.invitations!.accept.mock.invocationCallOrder[0]).toBeLessThan(state.identities!.startSessionForNihoIdentity.mock.invocationCallOrder[0]!);
    const cookies = setCookies(response);
    expect(cookies.get(ACCOUNT_SESSION_COOKIE)?.value).toBe(SESSION_TOKEN);
    expect(cookies.get(TEAM_INVITE_BINDING_COOKIE)?.attributes).toMatch(/Max-Age=0/);
    expect(calls.filter((call) => call.init.method === "DELETE")).toHaveLength(1);
    expect([location(response), ...response.headers.getSetCookie()].join("\n")).not.toMatch(new RegExp(`${NIHO_USER}|${ACCESS}|${CONNECTION}`));
  });

  it("ends the session this browser held before", async () => {
    state.accounts!.readSession.mockResolvedValue({ sessionRef: "1f8fad5b-d9cb-469f-a165-70867728950e" });
    const previous = "previousSessionToken".padEnd(43, "z");
    const started = await login(new NextRequest(startUrl, { headers: { cookie: `${TEAM_INVITE_BINDING_COOKIE}=${BINDING}` } }));
    const stateValue = new URL(location(started)).searchParams.get("state");
    const loginCookie = started.headers.getSetCookie().find((entry) => entry.startsWith(`${LOGIN_COOKIE}=`))!.split(";")[0]!;
    await callback(new NextRequest(`${SITE}/host/auth/callback?code=code-1&state=${stateValue}`, { headers: { cookie: `${loginCookie}; ${TEAM_INVITE_BINDING_COOKIE}=${BINDING}; ${ACCOUNT_SESSION_COOKIE}=${previous}` } }));
    expect(state.accounts!.revokeSession).toHaveBeenCalledWith(expect.objectContaining({ sessionToken: previous }));
  });

  it("tells each refusal in its own words and keeps the invitation and its cookie", async () => {
    const cases: [AcceptHostTeamInvitationResult, string][] = [
      [{ kind: "invalid" }, "team-invite-invalid"],
      [{ kind: "email-account-has-identity" }, "team-invite-mismatch"],
      [{ kind: "host-account-not-active" }, "suspended"],
    ];
    for (const [result, reason] of cases) {
      state.invitations!.accept.mockResolvedValueOnce(result);
      calls.length = 0;
      const response = await comeBack();
      expect(location(response), reason).toBe(`/host/auth/error?reason=${reason}`);
      expect(setCookies(response).has(ACCOUNT_SESSION_COOKIE)).toBe(false);
      expect(setCookies(response).has(TEAM_INVITE_BINDING_COOKIE)).toBe(false);
      expect(calls.filter((call) => call.init.method === "DELETE")).toHaveLength(1);
    }
    expect(state.identities!.startSessionForNihoIdentity).not.toHaveBeenCalled();
  });

  it("is unavailable, naming nothing, when the store fails, the cookie is gone or the flag went off", async () => {
    expect(location(await comeBack(null))).toBe("/host/auth/error?reason=team-invite-invalid");
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    state.invitations!.accept.mockRejectedValueOnce(new Error(`database said ${NIHO_USER} ${ACCESS}`));
    expect(location(await comeBack())).toBe("/host/auth/error?reason=team-invite-unavailable");
    expect(errors.mock.calls.flat().join(" ")).not.toMatch(new RegExp(`${NIHO_USER}|${ACCESS}`));
    // Joined, but the session did not open: the ordinary login is the way on.
    state.identities!.startSessionForNihoIdentity.mockResolvedValueOnce({ kind: "not-linked" });
    expect(location(await comeBack())).toBe("/host/auth/error?reason=unavailable");
    state.identities!.startSessionForNihoIdentity.mockRejectedValueOnce(new Error("boom"));
    expect(location(await comeBack())).toBe("/host/auth/error?reason=unavailable");
    expect(location(await comeBack(undefined, "&error=access_denied"))).toBe("/host/auth/error?reason=denied");
  });

  it("does not accept a team invitation's return once the flag is off", async () => {
    const started = await login(new NextRequest(startUrl, { headers: { cookie: `${TEAM_INVITE_BINDING_COOKIE}=${BINDING}` } }));
    const stateValue = new URL(location(started)).searchParams.get("state");
    const loginCookie = started.headers.getSetCookie().find((entry) => entry.startsWith(`${LOGIN_COOKIE}=`))!.split(";")[0]!;
    state.config.hostTeamInvitationsEnabled = false;
    const response = await callback(new NextRequest(`${SITE}/host/auth/callback?code=code-1&state=${stateValue}`, { headers: { cookie: `${loginCookie}; ${TEAM_INVITE_BINDING_COOKIE}=${BINDING}` } }));
    expect(location(response)).toBe("/host/auth/error?reason=team-invite-unavailable");
    expect(state.invitations!.accept).not.toHaveBeenCalled();
  });
});

describe("the error page for a team invitation", () => {
  async function page(reason: string) {
    return renderToStaticMarkup(await HostLoginErrorPage({ searchParams: Promise.resolve({ reason }) }));
  }

  it("says what to do for each reason, pointing at the person who invited, never at ops", async () => {
    const expected: Record<string, string> = {
      "team-invite-expired": "招待した人に、もう一度招待してもらってください",
      "team-invite-used": "ふつうにログインして入れます",
      "team-invite-browser": "最初に開いたブラウザでだけ続けられます",
      "team-invite-invalid": "招待した人に確かめてください",
      "team-invite-mismatch": "別の NIHO アカウントに結び付いています",
      "team-invite-unavailable": "招待はまだ使えます",
    };
    for (const [reason, words] of Object.entries(expected)) {
      const html = await page(reason);
      expect(html, reason).toContain("招待を使えませんでした");
      expect(html, reason).toContain(words);
      expect(html, reason).not.toContain("運営に");
      expect(html, reason).not.toMatch(/hst_|niho-user/);
    }
    expect(await page("team-invite-used")).toContain('href="/host/auth/login"');
    expect(await page("team-invite-mismatch")).toContain('href="/host/auth/login?teaminvite=1"');
    expect(await page("team-invite-unavailable")).toContain('href="/host/auth/login?teaminvite=1"');
  });
});
