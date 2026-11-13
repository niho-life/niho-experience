import { createHash } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AcceptHostInvitationResult, NihoSessionResult, OpenHostInvitationResult } from "@niho-experience/experience-store";

/**
 * 招待リンク (Epic #591, #596): the page the email's link opens, the sign-in that follows, and the return that binds the NIHO
 * account to the invited host account, against a synthetic NIHO and a stubbed store.
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
  invitations: null as { openInvitation: ReturnType<typeof import("vitest").vi.fn>; acceptInvitation: ReturnType<typeof import("vitest").vi.fn> } | null,
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
  hostInvitations: () => state.invitations,
  experiencePool: () => null,
}));
vi.mock("@/components/host/HostAppWindow", () => ({ HostLoginLink: ({ href, children }: { href: string; children: unknown }) => ({ type: "a", props: { href, children }, key: null, $$typeof: Symbol.for("react.transitional.element") }) }));

import { GET as invitePage, POST as inviteOpen } from "@/app/(host)/host/auth/invite/route";
import { GET as login } from "@/app/(host)/host/auth/login/route";
import { GET as callback } from "@/app/(host)/host/auth/callback/route";
import HostLoginErrorPage from "@/app/(host)/host/auth/error/page";
import { cookieSealer } from "./cookie-seal";
import { ACCOUNT_SESSION_COOKIE, decodeLoginState, INVITE_BINDING_COOKIE, LOGIN_COOKIE } from "./session";

const SITE = state.config.siteUrl;
const DAY = 86_400_000;
const HOST = `hst_${"e".repeat(32)}`;
const NIHO_USER = "niho-user-synthetic-invited";
const ACCESS = "niho-access-token-invite";
const CONNECTION = "conn_synthetic_invite";
const TOKEN = "inviteLinkToken".padEnd(43, "x");
const BINDING = "inviteBindingValue".padEnd(43, "y");
const SESSION_TOKEN = "sessionTokenInvited".padEnd(43, "x");
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest();
const sameOrigin = { origin: SITE, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" };

const calls: { url: URL; init: RequestInit }[] = [];
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  calls.length = 0;
  Object.assign(state.config, { hostConsoleEnabled: true, hostAccountsEnabled: true, hostNihoLoginEnabled: true, apiMode: "http" });
  state.cookies = { [INVITE_BINDING_COOKIE]: BINDING };
  state.invitations = {
    openInvitation: vi.fn(async (): Promise<OpenHostInvitationResult> => ({ kind: "opened" })),
    acceptInvitation: vi.fn(async (): Promise<AcceptHostInvitationResult> => ({ kind: "accepted", hostAccountId: HOST })),
  };
  state.identities = { startSessionForNihoIdentity: vi.fn(async (): Promise<NihoSessionResult> => ({ kind: "ok", sessionToken: SESSION_TOKEN, sessionRef: "0f8fad5b-d9cb-469f-a165-70867728950e", hostAccountId: HOST, absoluteExpiresAtUtc: new Date(Date.now() + 30 * DAY).toISOString() })) };
  state.accounts = { readSession: vi.fn(async () => null), revokeSession: vi.fn(async () => true) };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    if (url.pathname === "/api/auth/app-connect/exchange") return json(200, { accessToken: ACCESS, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), refreshToken: "refresh-invite", connectionId: CONNECTION, connectionExpiresAt: new Date(Date.now() + 90 * DAY).toISOString(), user: { displayName: "合成", iconImage: null } });
    if (url.pathname === "/api/experience-host/identity") return json(200, { nihoUserId: NIHO_USER, accountStatus: "ACTIVE" });
    if (init.method === "DELETE") return new Response(null, { status: 204 });
    return json(404, {});
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const post = (body: string, headers: Record<string, string> = sameOrigin, cookie = "") => new NextRequest(`${SITE}/host/auth/invite`, { method: "POST", headers: { ...headers, ...(cookie ? { cookie } : {}) }, body });
const location = (response: Response) => response.headers.get("location")!;
const setCookies = (response: Response) => new Map(response.headers.getSetCookie().map((header) => {
  const [pair = "", ...attributes] = header.split("; ");
  const index = pair.indexOf("=");
  return [pair.slice(0, index), { value: pair.slice(index + 1), attributes: attributes.join("; ") }] as const;
}));

describe("the page the invitation email opens", () => {
  it("is a no-store, no-referrer page whose script reads the token from the fragment and posts it to the same path", async () => {
    const response = invitePage();
    expect(response.status).toBe(200);
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cache-control")).toContain("no-store");
    const html = await response.text();
    expect(html).toContain("location.hash");
    expect(html).toContain("history.replaceState");
    expect(html).toContain('"/host/auth/invite"');
    // On success the page goes to the NIHO sign-in; failures go to the page that says why (only the invitation's reasons).
    expect(html).toContain('"/host/auth/login?invite=1"');
    for (const reason of ["invite-expired", "invite-used", "invite-browser", "invite-invalid"]) expect(html).toContain(reason);
    state.config.hostNihoLoginEnabled = false;
    expect(invitePage().status).toBe(404);
  });
});

describe("opening the invitation", () => {
  it("binds the invitation to this browser: a new random cookie whose SHA-256 the store keeps", async () => {
    const response = await inviteOpen(post(`t=${TOKEN}`, sameOrigin, ""));
    expect(response.status).toBe(204);
    const cookie = setCookies(response).get(INVITE_BINDING_COOKIE)!;
    expect(cookie.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cookie.attributes).toMatch(/HttpOnly/);
    expect(cookie.attributes).toMatch(/Path=\/host\/auth/);
    expect(cookie.attributes).toMatch(/Max-Age=604800/);
    expect(state.invitations!.openInvitation).toHaveBeenCalledWith({ token: TOKEN, browserBindingHash: sha256(cookie.value), nowUtc: expect.any(String) });
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("keeps the browser's own cookie when it opens the link again", async () => {
    const response = await inviteOpen(post(`t=${TOKEN}`, sameOrigin, `${INVITE_BINDING_COOKIE}=${BINDING}`));
    expect(response.status).toBe(204);
    expect(setCookies(response).get(INVITE_BINDING_COOKIE)?.value).toBe(BINDING);
    expect(state.invitations!.openInvitation).toHaveBeenCalledWith(expect.objectContaining({ browserBindingHash: sha256(BINDING) }));
  });

  it("opens again with a new value when the browser's own holds another open invitation", async () => {
    state.invitations!.openInvitation.mockResolvedValueOnce({ kind: "binding-in-use" });
    const response = await inviteOpen(post(`t=${TOKEN}`, sameOrigin, `${INVITE_BINDING_COOKIE}=${BINDING}`));
    expect(response.status).toBe(204);
    const fresh = setCookies(response).get(INVITE_BINDING_COOKIE)!.value;
    expect(fresh).not.toBe(BINDING);
    expect(state.invitations!.openInvitation.mock.calls.map(([input]) => (input as { browserBindingHash: Buffer }).browserBindingHash)).toEqual([sha256(BINDING), sha256(fresh)]);
    // A value that is taken twice is just an invitation that cannot be used.
    state.invitations!.openInvitation.mockResolvedValue({ kind: "binding-in-use" });
    expect(await (await inviteOpen(post(`t=${TOKEN}`, sameOrigin, `${INVITE_BINDING_COOKIE}=${BINDING}`))).json()).toEqual({ reason: "invite-invalid" });
  });

  it("tells why a link cannot be used, in the invitation's words, and sets no cookie", async () => {
    const reasons: [OpenHostInvitationResult, string][] = [
      [{ kind: "expired" }, "invite-expired"], [{ kind: "used" }, "invite-used"], [{ kind: "other-browser" }, "invite-browser"], [{ kind: "invalid" }, "invite-invalid"],
    ];
    for (const [result, reason] of reasons) {
      state.invitations!.openInvitation.mockResolvedValueOnce(result);
      const response = await inviteOpen(post(`t=${TOKEN}`));
      expect(response.status, reason).toBe(400);
      expect(await response.json()).toEqual({ reason });
      expect(response.headers.getSetCookie()).toEqual([]);
    }
  });

  it("refuses a cross-site post, a wrong body, a short token and a switched-off flag, and a store failure is a 503 that names nothing", async () => {
    expect((await inviteOpen(post(`t=${TOKEN}`, { ...sameOrigin, origin: "https://evil.example.test", "sec-fetch-site": "cross-site" }))).status).toBe(403);
    expect((await inviteOpen(post(`t=${TOKEN}&x=1`))).status).toBe(400);
    expect((await inviteOpen(post("t=short"))).status).toBe(400);
    expect(state.invitations!.openInvitation).not.toHaveBeenCalled();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    state.invitations!.openInvitation.mockRejectedValueOnce(new Error(`database said ${TOKEN}`));
    expect((await inviteOpen(post(`t=${TOKEN}`))).status).toBe(503);
    expect(errors.mock.calls.flat().join(" ")).not.toContain(TOKEN);
    state.config.hostNihoLoginEnabled = false;
    expect((await inviteOpen(post(`t=${TOKEN}`))).status).toBe(404);
  });
});

describe("the NIHO sign-in of an invitation", () => {
  async function comeBack(cookieAtReturn: Record<string, string> | null = { [INVITE_BINDING_COOKIE]: BINDING }, search = "") {
    const started = await login(new NextRequest(`${SITE}/host/auth/login?invite=1`, { headers: { cookie: `${INVITE_BINDING_COOKIE}=${BINDING}` } }));
    const stateValue = new URL(location(started)).searchParams.get("state");
    const loginCookie = started.headers.getSetCookie().find((entry) => entry.startsWith(`${LOGIN_COOKIE}=`))!.split(";")[0]!;
    const cookie = [loginCookie, ...Object.entries(cookieAtReturn ?? {}).map(([name, value]) => `${name}=${value}`)].join("; ");
    return callback(new NextRequest(`${SITE}/host/auth/callback?code=code-1&state=${stateValue}${search}`, { headers: { cookie } }));
  }

  it("starts at NIHO only for a browser that opened an invitation, with no step-up", async () => {
    const without = await login(new NextRequest(`${SITE}/host/auth/login?invite=1`));
    expect(location(without)).toBe("/host/auth/error?reason=invite-invalid");
    const started = await login(new NextRequest(`${SITE}/host/auth/login?invite=1`, { headers: { cookie: `${INVITE_BINDING_COOKIE}=${BINDING}` } }));
    const to = new URL(location(started));
    expect(to.origin).toBe("https://niho.example.test");
    expect(to.searchParams.get("audience")).toBe("host");
    expect(to.searchParams.get("max_age")).toBeNull();
    const header = started.headers.getSetCookie().find((entry) => entry.startsWith(`${LOGIN_COOKIE}=`))!;
    expect(decodeLoginState(cookieSealer(state.config.hostSessionSecret, "login"), header.split(";")[0]!.slice(LOGIN_COOKIE.length + 1), Date.now())).toMatchObject({ purpose: "invite" });
    // A signed-in host still goes through NIHO: the invitation is for binding.
    state.accounts!.readSession.mockResolvedValue({ hostAccountId: HOST });
    expect(new URL(location(await login(new NextRequest(`${SITE}/host/auth/login?invite=1`, { headers: { cookie: `${INVITE_BINDING_COOKIE}=${BINDING}; ${ACCOUNT_SESSION_COOKIE}=${SESSION_TOKEN}` } })))).origin).toBe("https://niho.example.test");
  });

  it("binds the NIHO account to the invited host account, opens its session, clears the invitation's cookie and ends the connection", async () => {
    const response = await comeBack();
    expect(location(response)).toBe("/host/home");
    expect(state.invitations!.acceptInvitation).toHaveBeenCalledWith({ browserBindingHash: sha256(BINDING), nihoUserId: NIHO_USER, nowUtc: expect.any(String) });
    expect(state.identities!.startSessionForNihoIdentity).toHaveBeenCalledWith(expect.objectContaining({ nihoUserId: NIHO_USER }));
    // The invitation is accepted before the session opens.
    expect(state.invitations!.acceptInvitation.mock.invocationCallOrder[0]).toBeLessThan(state.identities!.startSessionForNihoIdentity.mock.invocationCallOrder[0]!);
    const cookies = setCookies(response);
    expect(cookies.get(ACCOUNT_SESSION_COOKIE)?.value).toBe(SESSION_TOKEN);
    expect(cookies.get(INVITE_BINDING_COOKIE)?.attributes).toMatch(/Max-Age=0/);
    expect(calls.map((call) => `${call.init.method ?? "GET"} ${call.url.pathname}`)).toEqual([
      "POST /api/auth/app-connect/exchange", "GET /api/experience-host/identity", `DELETE /api/auth/app-connections/${CONNECTION}`,
    ]);
    expect([location(response), ...response.headers.getSetCookie()].join("\n")).not.toMatch(new RegExp(`${NIHO_USER}|${ACCESS}|${CONNECTION}`));
  });

  it("opens the session with the time the person signed in at NIHO (authTime)", async () => {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60_000).toISOString();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input));
      calls.push({ url, init });
      if (url.pathname === "/api/auth/app-connect/exchange") return json(200, { accessToken: ACCESS, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), refreshToken: "refresh-invite", connectionId: CONNECTION, connectionExpiresAt: new Date(Date.now() + 90 * DAY).toISOString(), user: { displayName: "合成", iconImage: null }, authTime: tenMinutesAgo });
      if (url.pathname === "/api/experience-host/identity") return json(200, { nihoUserId: NIHO_USER, accountStatus: "ACTIVE" });
      return new Response(null, { status: 204 });
    }));
    await comeBack();
    expect(state.identities!.startSessionForNihoIdentity).toHaveBeenCalledWith(expect.objectContaining({ nihoUserId: NIHO_USER, authenticatedAtUtc: tenMinutesAgo }));
  });

  it("tells each refusal in its own words, keeps the invitation, and ends the connection", async () => {
    const cases: [AcceptHostInvitationResult, string][] = [
      [{ kind: "invalid" }, "invite-invalid"],
      [{ kind: "identity-in-use" }, "invite-in-use"],
      [{ kind: "account-has-identity" }, "invite-has-identity"],
      [{ kind: "host-account-not-active" }, "suspended"],
    ];
    for (const [result, reason] of cases) {
      state.invitations!.acceptInvitation.mockResolvedValueOnce(result);
      calls.length = 0;
      const response = await comeBack();
      expect(location(response), reason).toBe(`/host/auth/error?reason=${reason}`);
      expect(setCookies(response).has(ACCOUNT_SESSION_COOKIE)).toBe(false);
      // The invitation's cookie stays: the host signs in with the right NIHO account and the same link still works.
      expect(setCookies(response).has(INVITE_BINDING_COOKIE)).toBe(false);
      expect(calls.filter((call) => call.init.method === "DELETE")).toHaveLength(1);
    }
    expect(state.identities!.startSessionForNihoIdentity).not.toHaveBeenCalled();
  });

  it("asks for a new invitation when the browser's cookie is gone, and treats a store failure as an outage naming nothing", async () => {
    expect(location(await comeBack(null))).toBe("/host/auth/error?reason=invite-invalid");
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    state.invitations!.acceptInvitation.mockRejectedValueOnce(new Error(`database said ${NIHO_USER} ${ACCESS}`));
    expect(location(await comeBack())).toBe("/host/auth/error?reason=unavailable");
    expect(errors.mock.calls.flat().join(" ")).not.toMatch(new RegExp(`${NIHO_USER}|${ACCESS}`));
    // The binding is kept when only the session fails to open.
    state.identities!.startSessionForNihoIdentity.mockResolvedValueOnce({ kind: "not-linked" });
    expect(location(await comeBack())).toBe("/host/auth/error?reason=unavailable");
    expect(location(await comeBack(undefined, "&error=access_denied"))).toBe("/host/auth/error?reason=denied");
  });
});

describe("the error page for an invitation", () => {
  async function page(reason: string) {
    return renderToStaticMarkup(await HostLoginErrorPage({ searchParams: Promise.resolve({ reason }) }));
  }

  it("says what to do for each reason: a link that cannot be used asks ops for a new invitation, a refusal offers the way on", async () => {
    for (const reason of ["invite-expired", "invite-invalid", "invite-browser"]) {
      const html = await page(reason);
      expect(html, reason).toContain("招待を使えませんでした");
      expect(html, reason).toContain("運営に問い合わせる");
      expect(html, reason).toContain("mailto:info@niho.life");
      expect(html, reason).not.toContain("<a href=\"/host/auth/login");
    }
    expect(await page("invite-expired")).toContain("新しい招待を依頼してください");
    expect(await page("invite-browser")).toContain("最初にリンクを開いたブラウザ");
    expect(await page("invite-used")).toContain('href="/host/auth/login"');
    expect(await page("invite-in-use")).toContain('href="/host/auth/login?invite=1"');
    expect(await page("invite-has-identity")).toContain("結び付けた NIHO アカウントでログインしてください");
    // Nothing names an account.
    for (const reason of ["invite-in-use", "invite-has-identity"]) expect(await page(reason)).not.toMatch(/hst_|niho-user/);
  });
});
