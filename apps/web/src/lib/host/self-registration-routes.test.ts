import { NextRequest } from "next/server";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderPublicNameError, StoreRateLimitedError, StoreValidationError } from "@niho-experience/experience-store";
import type { NihoSessionResult } from "@niho-experience/experience-store";

/**
 * 自分でホスト登録する (Epic #700, #708): the NIHO login's continuation into the registration screen, the sealed 30-minute cookie, the
 * registration API and the screen's decisions, against a synthetic NIHO and a stubbed store. With the flag off nothing changes.
 */
const state = vi.hoisted(() => ({
  config: {
    apiMode: "http",
    hostConsoleEnabled: true,
    hostAccountsEnabled: true,
    hostNihoLoginEnabled: true,
    hostSelfRegistrationEnabled: true,
    nihoIdentityLoginEnabled: false,
    nihoLoginPromptEnabled: false,
    nihoWriterEnabled: false,
    hostPwaEnabled: false,
    hostPushEnabled: false,
    hostSessionSecret: "synthetic-route-test-secret-0123456789abcdef",
    nihoWebOrigin: "https://niho.example.test",
    nihoExperienceHostCommonContractAudience: "https://api.niho.example.test",
    nihoArticleAuthorityOrigin: "https://api.niho.example.test",
    nihoArticleAuthorityAudience: "https://api.niho.example.test",
    siteUrl: "https://experience.example.test",
  } as Record<string, unknown>,
  cookies: {} as Record<string, string>,
  identities: {} as Record<"startSessionForNihoIdentity" | "startWriterSessionForNihoIdentity" | "registerHostSelf" | "registerHostSelfForAccount", ReturnType<typeof import("vitest").vi.fn>>,
  accounts: {} as Record<"readSession" | "revokeSession" | "listProviderMemberships", ReturnType<typeof import("vitest").vi.fn>>,
}));
vi.mock("server-only", () => ({}));
vi.mock("react", async (importOriginal) => ({ ...(await importOriginal<typeof import("react")>()), cache: (read: unknown) => read }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (name: string) => (name in state.cookies ? { name, value: state.cookies[name] } : undefined) }) }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => { throw new Error(`REDIRECT ${to}`); },
  notFound: () => { throw new Error("NOT_FOUND"); },
  usePathname: () => "/host/start",
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("google-auth-library", () => ({ OAuth2Client: class {}, GoogleAuth: class {
  async getIdTokenClient() { return { getRequestHeaders: async () => ({ authorization: "Bearer synthetic-service-id-token" }) }; }
} }));
vi.mock("@/lib/config", () => ({ get config() { return state.config; }, isPreview: false }));
vi.mock("@/lib/experience/store-server", () => ({
  hostAccounts: () => state.accounts,
  hostAccountIdentities: () => state.identities,
  experiencePool: () => null,
}));

import { GET as login } from "@/app/(host)/host/auth/login/route";
import { GET as callback } from "@/app/(host)/host/auth/callback/route";
import { GET as mockLogin } from "@/app/(host)/host/auth/mock-login/route";
import { POST as register } from "@/app/(host)/host/api/registration/route";
import { POST as logout } from "@/app/(host)/host/auth/logout/route";
import HostStartPage from "@/app/(host)/host/start/page";
import HostTermsPage from "@/app/(host)/host/terms/page";
import { cookieSealer } from "./cookie-seal";
import { HOST_TERMS_VERSION } from "./host-terms";
import { nameAfterKindChange } from "./self-registration-form";
import { ACCOUNT_SESSION_COOKIE, decodeLoginState, decodeRegistration, encodeRegistration, LOGIN_COOKIE, REGISTRATION_COOKIE, RETURNING_HOST_COOKIE } from "./session";

const SITE = state.config.siteUrl as string;
const SECRET = state.config.hostSessionSecret as string;
const DAY = 86_400_000;
const HOST = `hst_${"c".repeat(32)}`;
const NEW_HOST = `hst_${"d".repeat(32)}`;
const PROVIDER = `prv_${"e".repeat(32)}`;
const NIHO_USER = "niho-user-synthetic-1";
const ACCESS = "niho-access-token-synthetic";
const CONNECTION = "conn_synthetic_1";
const SESSION_TOKEN = "sessionTokenOpened".padEnd(43, "x");
const OLD_SESSION_TOKEN = "oldSessionToken".padEnd(43, "x");

let displayName = "合成 ホスト";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const exchangeBody = () => ({ accessToken: ACCESS, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), refreshToken: "refresh-synthetic", connectionId: CONNECTION, connectionExpiresAt: new Date(Date.now() + 90 * DAY).toISOString(), user: { displayName, iconImage: null }, authTime: new Date(Date.now() - 60_000).toISOString() });

const registered = (): Record<string, unknown> => ({ kind: "registered", sessionToken: SESSION_TOKEN, sessionRef: "0f8fad5b-d9cb-469f-a165-70867728950e", hostAccountId: NEW_HOST, absoluteExpiresAtUtc: new Date(Date.now() + 30 * DAY).toISOString(), providerId: PROVIDER, notificationAddress: "PENDING" });
const opened = async (): Promise<NihoSessionResult> => ({ kind: "ok", sessionToken: SESSION_TOKEN, sessionRef: "0f8fad5b-d9cb-469f-a165-70867728950e", hostAccountId: HOST, absoluteExpiresAtUtc: new Date(Date.now() + 30 * DAY).toISOString() });
const sessionRow = () => ({ hostAccountId: HOST, email: null, sessionRef: "0f8fad5b-d9cb-469f-a165-70867728950e", authenticatedAtUtc: new Date().toISOString(), idleExpiresAtUtc: new Date(Date.now() + DAY).toISOString(), absoluteExpiresAtUtc: new Date(Date.now() + 2 * DAY).toISOString() });

beforeEach(() => {
  Object.assign(state.config, { apiMode: "http", hostConsoleEnabled: true, hostAccountsEnabled: true, hostNihoLoginEnabled: true, hostSelfRegistrationEnabled: true, nihoIdentityLoginEnabled: false, nihoWriterEnabled: false });
  state.cookies = {};
  displayName = "合成 ホスト";
  state.identities = {
    startSessionForNihoIdentity: vi.fn(opened),
    startWriterSessionForNihoIdentity: vi.fn(opened),
    registerHostSelf: vi.fn(async () => registered()),
    registerHostSelfForAccount: vi.fn(async () => ({ kind: "registered", providerId: PROVIDER, notificationAddress: "PENDING" })),
  };
  state.accounts = {
    readSession: vi.fn(async () => null),
    revokeSession: vi.fn(async () => true),
    listProviderMemberships: vi.fn(async () => []),
  };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/auth/app-connect/exchange") return json(200, exchangeBody());
    if (url.pathname === "/api/experience-host/identity") return json(200, { nihoUserId: NIHO_USER, accountStatus: "ACTIVE" });
    if (url.pathname === "/api/internal/editor-article-authority/check") return json(200, { version: 1, writer: false, links: [] });
    if (init.method === "DELETE") return new Response(null, { status: 204 });
    return json(404, { error: "not_found" });
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

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
  const location = new URL(response.headers.get("location")!, SITE);
  const cookie = setCookies(response).get(LOGIN_COOKIE);
  return { response, location, cookie: cookie ? `${LOGIN_COOKIE}=${cookie.value}` : "" };
}

async function signIn(query = "") {
  const { location, cookie } = await startLogin(query);
  const response = await callback(new NextRequest(`${SITE}/host/auth/callback?code=code-1&state=${location.searchParams.get("state")}`, { headers: { cookie } }));
  return { response };
}

const sealer = () => cookieSealer(SECRET, "host-registration");
const registrationCookie = (overrides: Partial<{ nihoUserId: string; authTimeMs: number; displayName: string | null; expiresAt: number }> = {}) =>
  `${REGISTRATION_COOKIE}=${encodeRegistration(sealer(), { nihoUserId: NIHO_USER, authTimeMs: Date.now() - 60_000, displayName: "森 ゆき", expiresAt: Date.now() + 20 * 60_000, ...overrides })}`;

const FORM = { providerKind: "PERSON", publicDisplayName: "森 ゆき", publicDisplayNameEn: "Yuki Mori", notificationEmail: "yuki@example.test", hostTermsVersion: HOST_TERMS_VERSION, termsAccepted: true };
function post(body: unknown, options: { cookie?: string; headers?: Record<string, string> } = {}) {
  return register(new NextRequest(`${SITE}/host/api/registration`, {
    method: "POST",
    headers: { origin: SITE, "sec-fetch-site": "same-origin", "content-type": "application/json", ...(options.cookie ? { cookie: options.cookie } : {}), ...options.headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));
}
const errorOf = async (response: Response) => ((await response.json()) as { error: { code: string; field?: string; limit?: number } }).error;

describe("the NIHO login's continuation into the registration", () => {
  it("is the ordinary login while the flag is off: intent is ignored and a NIHO account with no host account is told so", async () => {
    state.config.hostSelfRegistrationEnabled = false;
    const start = await startLogin("?intent=register");
    expect(decodeLoginState(cookieSealer(SECRET, "login"), start.cookie.slice(LOGIN_COOKIE.length + 1), Date.now())?.purpose).toBeUndefined();
    state.identities.startSessionForNihoIdentity.mockResolvedValue({ kind: "not-linked" });
    const { response } = await signIn("?intent=register");
    expect(response.headers.get("location")).toBe("/host/auth/error?reason=unregistered");
    expect(setCookies(response).has(REGISTRATION_COOKIE)).toBe(false);
    // A host already signed in is not taken to the registration either.
    state.cookies[ACCOUNT_SESSION_COOKIE] = SESSION_TOKEN;
    state.accounts.readSession.mockResolvedValue(sessionRow());
    expect((await login(new NextRequest(`${SITE}/host/auth/login?intent=register`))).headers.get("location")).toBe("/host/home");
  });

  it("remembers the intent in the login state, and sends a host who is already signed in straight to the registration", async () => {
    const start = await startLogin("?intent=register");
    expect(start.location.origin).toBe("https://niho.example.test");
    expect(decodeLoginState(cookieSealer(SECRET, "login"), start.cookie.slice(LOGIN_COOKIE.length + 1), Date.now())?.purpose).toBe("register");
    expect(decodeLoginState(cookieSealer(SECRET, "login"), (await startLogin()).cookie.slice(LOGIN_COOKIE.length + 1), Date.now())?.purpose).toBeUndefined();
    state.cookies[ACCOUNT_SESSION_COOKIE] = SESSION_TOKEN;
    state.accounts.readSession.mockResolvedValue(sessionRow());
    expect((await login(new NextRequest(`${SITE}/host/auth/login?intent=register`))).headers.get("location")).toBe("/host/start");
    expect((await login(new NextRequest(`${SITE}/host/auth/login`))).headers.get("location")).toBe("/host/home");
  });

  it("puts what NIHO proved in a sealed 30-minute cookie for /host and creates nothing, for the intent and for the ordinary login alike", async () => {
    state.identities.startSessionForNihoIdentity.mockResolvedValue({ kind: "not-linked" });
    for (const query of ["?intent=register", ""]) {
      const { response } = await signIn(query);
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/host/start");
      const cookies = setCookies(response);
      const cookie = cookies.get(REGISTRATION_COOKIE)!;
      expect(cookie.attributes).toMatch(/HttpOnly/);
      expect(cookie.attributes).toMatch(/Secure/);
      expect(cookie.attributes).toMatch(/SameSite=lax/i);
      expect(cookie.attributes).toMatch(/Path=\/host(;|$)/);
      expect(cookie.attributes).toMatch(/Max-Age=1800/);
      const held = decodeRegistration(sealer(), cookie.value, Date.now())!;
      expect(held).toMatchObject({ nihoUserId: NIHO_USER, displayName });
      expect(held.authTimeMs).toBeLessThanOrEqual(Date.now());
      expect(held.expiresAt - Date.now()).toBeGreaterThan(29 * 60_000);
      // The NIHO connection ended; no session, no returning-host mark; the login cookie is gone.
      expect(cookies.has(ACCOUNT_SESSION_COOKIE)).toBe(false);
      expect(cookies.has(RETURNING_HOST_COOKIE)).toBe(false);
      expect(cookies.get(LOGIN_COOKIE)?.attributes).toMatch(/Max-Age=0/);
    }
    expect(state.identities.registerHostSelf).not.toHaveBeenCalled();
    expect(state.identities.registerHostSelfForAccount).not.toHaveBeenCalled();
  });

  it("cuts a long NIHO name, and carries none when NIHO gave none", async () => {
    state.identities.startSessionForNihoIdentity.mockResolvedValue({ kind: "not-linked" });
    displayName = "あ".repeat(200);
    const long = decodeRegistration(sealer(), setCookies((await signIn()).response).get(REGISTRATION_COOKIE)!.value, Date.now())!;
    expect(long.displayName?.length).toBeLessThanOrEqual(80);
    displayName = "";
    expect(decodeRegistration(sealer(), setCookies((await signIn()).response).get(REGISTRATION_COOKIE)!.value, Date.now())?.displayName).toBeNull();
  });

  it("signs a NIHO account that is already bound in as usual, to the home, with no registration cookie", async () => {
    const { response } = await signIn("?intent=register");
    expect(response.headers.get("location")).toBe("/host/home");
    const cookies = setCookies(response);
    // Only ever the clearing of an old one (see below), never a new registration.
    expect(cookies.get(REGISTRATION_COOKIE)?.value ?? "").toBe("");
    expect(cookies.get(ACCOUNT_SESSION_COOKIE)?.value).toBe(SESSION_TOKEN);
  });

  it("ends a registration an earlier NIHO sign-in left behind once another account signs in, and lets 「別のアカウントで続ける」 reach NIHO", async () => {
    // A (no host account) left a registration cookie; B, a host, signs in on the same browser before it expires.
    const { location, cookie } = await startLogin();
    const response = await callback(new NextRequest(`${SITE}/host/auth/callback?code=code-1&state=${location.searchParams.get("state")}`, { headers: { cookie: `${cookie}; ${registrationCookie()}` } }));
    expect(response.headers.get("location")).toBe("/host/home");
    const cookies = setCookies(response);
    expect(cookies.get(ACCOUNT_SESSION_COOKIE)?.value).toBe(SESSION_TOKEN);
    expect(cookies.get(REGISTRATION_COOKIE)?.value).toBe("");
    expect(cookies.get(REGISTRATION_COOKIE)?.attributes).toMatch(/Max-Age=0/);
    // Signed in as B, 「別のアカウントで続ける」 goes to NIHO, not back to /host/start.
    state.cookies[ACCOUNT_SESSION_COOKIE] = SESSION_TOKEN;
    state.accounts.readSession.mockResolvedValue(sessionRow());
    const switched = await startLogin("?intent=register&switch=1");
    expect(switched.location.origin).toBe("https://niho.example.test");
    // Logging out ends it too: it is not for whoever uses this browser next.
    const out = await logout(new NextRequest(`${SITE}/host/auth/logout`, { method: "POST", headers: { origin: SITE, "sec-fetch-site": "same-origin", cookie: registrationCookie() } }));
    expect(setCookies(out).get(REGISTRATION_COOKIE)?.attributes).toMatch(/Max-Age=0/);
  });

  it("leaves a suspended host account and the writer's return (/write) as they were", async () => {
    state.identities.startSessionForNihoIdentity.mockResolvedValue({ kind: "account-suspended" });
    expect((await signIn()).response.headers.get("location")).toBe("/host/auth/error?reason=suspended");
    state.identities.startSessionForNihoIdentity.mockResolvedValue({ kind: "not-linked" });
    state.config.nihoWriterEnabled = true;
    // Not a writer any more: the writer's own message, not the registration.
    const writing = await signIn(`?returnTo=${encodeURIComponent("/write")}`);
    expect(writing.response.headers.get("location")).toBe("/host/auth/error?reason=writer-revoked");
    expect(setCookies(writing.response).has(REGISTRATION_COOKIE)).toBe(false);
  });
});

describe("the preview", () => {
  it("walks a synthetic NIHO account to the registration with a made-up name, and keeps nothing", async () => {
    state.config.apiMode = "mock";
    state.config.hostAccountsEnabled = false;
    const viaLogin = await login(new NextRequest(`${SITE}/host/auth/login?intent=register`));
    expect(viaLogin.headers.get("location")).toBe("/host/auth/mock-login?intent=register");
    const response = await mockLogin(new NextRequest(`${SITE}/host/auth/mock-login?mock=unregistered`));
    expect(response.headers.get("location")).toBe("/host/start");
    const held = decodeRegistration(sealer(), setCookies(response).get(REGISTRATION_COOKIE)!.value, Date.now());
    expect(held?.displayName).toBe("森 ゆき");
    state.cookies[REGISTRATION_COOKIE] = setCookies(response).get(REGISTRATION_COOKIE)!.value;
    const done = await post(FORM, { cookie: `${REGISTRATION_COOKIE}=${state.cookies[REGISTRATION_COOKIE]}` });
    expect(done.status).toBe(200);
    expect(await done.json()).toEqual({ ok: true, redirect: "/host/auth/mock-login" });
    expect(state.identities.registerHostSelf).not.toHaveBeenCalled();
    state.config.hostSelfRegistrationEnabled = false;
    expect((await mockLogin(new NextRequest(`${SITE}/host/auth/mock-login?mock=unregistered`))).headers.get("location")).toBe("/host/auth/error?reason=unregistered");
  });
});

describe("POST /host/api/registration", () => {
  it("is a 404 without the flag and refuses a post from another origin, a wrong media type, an oversized or malformed body", async () => {
    state.config.hostSelfRegistrationEnabled = false;
    expect((await post(FORM, { cookie: registrationCookie() })).status).toBe(404);
    state.config.hostSelfRegistrationEnabled = true;
    expect((await post(FORM, { cookie: registrationCookie(), headers: { origin: "https://evil.example.test" } })).status).toBe(403);
    expect((await post(FORM, { cookie: registrationCookie(), headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
    expect((await post(FORM, { cookie: registrationCookie(), headers: { "content-type": "text/plain" } })).status).toBe(415);
    expect((await post("x".repeat(5000), { cookie: registrationCookie() })).status).toBe(413);
    expect((await post("{", { cookie: registrationCookie() })).status).toBe(400);
    expect((await post({ ...FORM, extra: 1 }, { cookie: registrationCookie() })).status).toBe(400);
    expect((await post({ ...FORM, providerKind: "COMPANY" }, { cookie: registrationCookie() })).status).toBe(400);
    expect(state.identities.registerHostSelf).not.toHaveBeenCalled();
  });

  it("registers from the cookie: the store gets NIHO's sign-in time, the session cookie is set, the old session ends and the registration cookie goes", async () => {
    const authTimeMs = Date.now() - 5 * 60_000;
    const response = await post(FORM, { cookie: [registrationCookie({ authTimeMs }), `${ACCOUNT_SESSION_COOKIE}=${OLD_SESSION_TOKEN}`].join("; ") });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ ok: true, redirect: `/host/home?providerId=${PROVIDER}` });
    expect(state.identities.registerHostSelf).toHaveBeenCalledTimes(1);
    const input = state.identities.registerHostSelf.mock.calls[0]![0] as Record<string, unknown>;
    expect(input).toMatchObject({ nihoUserId: NIHO_USER, authenticatedAtUtc: new Date(authTimeMs).toISOString(), providerKind: "PERSON", publicDisplayName: "森 ゆき", publicDisplayNameEn: "Yuki Mori", hostTermsVersion: HOST_TERMS_VERSION, notificationEmail: "yuki@example.test" });
    expect(Date.parse(input.nowUtc as string)).toBeLessThanOrEqual(Date.now());
    const cookies = setCookies(response);
    expect(cookies.get(ACCOUNT_SESSION_COOKIE)?.value).toBe(SESSION_TOKEN);
    expect(cookies.get(RETURNING_HOST_COOKIE)?.value).toBe("1");
    expect(cookies.get(REGISTRATION_COOKIE)?.attributes).toMatch(/Max-Age=0/);
    expect(cookies.get(REGISTRATION_COOKIE)?.attributes).toMatch(/Path=\/host(;|$)/);
    expect(state.accounts.revokeSession).toHaveBeenCalledWith(expect.objectContaining({ sessionToken: OLD_SESSION_TOKEN }));
  });

  it("passes a business and a missing English name as they are, and trims what the person typed", async () => {
    const response = await post({ ...FORM, providerKind: "BUSINESS", publicDisplayName: "  葉山クラフト ", publicDisplayNameEn: "  ", notificationEmail: " craft@example.test " }, { cookie: registrationCookie() });
    expect(response.status).toBe(200);
    expect(state.identities.registerHostSelf.mock.calls[0]![0]).toMatchObject({ providerKind: "BUSINESS", publicDisplayName: "葉山クラフト", publicDisplayNameEn: null, notificationEmail: "craft@example.test" });
  });

  it("answers each store result with its own code, keeps the registration cookie when the person can try again, and writes no session", async () => {
    const cookie = registrationCookie();
    state.identities.registerHostSelf.mockResolvedValueOnce({ kind: "already-linked" });
    const linked = await post(FORM, { cookie });
    expect([linked.status, (await errorOf(linked)).code]).toEqual([409, "ALREADY_REGISTERED"]);
    expect(setCookies(linked).get(REGISTRATION_COOKIE)?.attributes).toMatch(/Max-Age=0/);
    expect(setCookies(linked).has(ACCOUNT_SESSION_COOKIE)).toBe(false);

    state.identities.registerHostSelf.mockResolvedValueOnce({ kind: "owner-limit-reached" });
    const limit = await post(FORM, { cookie });
    expect(limit.status).toBe(409);
    expect(await errorOf(limit)).toEqual({ code: "OWNER_LIMIT_REACHED", limit: 3 });

    state.identities.registerHostSelf.mockResolvedValueOnce({ kind: "account-suspended" });
    const suspended = await post(FORM, { cookie });
    expect([suspended.status, (await errorOf(suspended)).code]).toEqual([403, "ACCOUNT_SUSPENDED"]);

    state.identities.registerHostSelf.mockRejectedValueOnce(new ProviderPublicNameError("PUBLIC_NAME_RESERVED", "publicDisplayName", "reserved"));
    const reserved = await post({ ...FORM, publicDisplayName: "NIHO 公式" }, { cookie });
    expect(reserved.status).toBe(422);
    expect(await errorOf(reserved)).toEqual({ code: "PUBLIC_NAME_RESERVED", field: "name" });

    state.identities.registerHostSelf.mockRejectedValueOnce(new ProviderPublicNameError("PUBLIC_NAME_INVALID", "publicDisplayNameEn", "invalid"));
    expect(await errorOf(await post(FORM, { cookie }))).toEqual({ code: "PUBLIC_NAME_INVALID", field: "nameEn" });

    state.identities.registerHostSelf.mockRejectedValueOnce(new StoreRateLimitedError(900));
    const limited = await post(FORM, { cookie });
    expect([limited.status, limited.headers.get("retry-after"), (await errorOf(limited)).code]).toEqual([429, "900", "RATE_LIMITED"]);

    state.identities.registerHostSelf.mockRejectedValueOnce(new StoreValidationError("email must be an email address of 3-254 characters."));
    expect(await errorOf(await post(FORM, { cookie }))).toEqual({ code: "EMAIL_INVALID", field: "email" });

    vi.spyOn(console, "error").mockImplementation(() => undefined);
    state.identities.registerHostSelf.mockRejectedValueOnce(new Error("connection refused for niho-user-synthetic-1"));
    const down = await post(FORM, { cookie });
    expect([down.status, (await errorOf(down)).code]).toEqual([503, "UNAVAILABLE"]);
    expect(String(vi.mocked(console.error).mock.calls.flat())).not.toContain(NIHO_USER);
  });

  it("checks the form before the store: a missing agreement, a bad address, an empty or too long name, an old terms version", async () => {
    const cookie = registrationCookie();
    expect(await errorOf(await post({ ...FORM, termsAccepted: false }, { cookie }))).toEqual({ code: "TERMS_REQUIRED", field: "terms" });
    expect(await errorOf(await post({ ...FORM, notificationEmail: "not-an-address" }, { cookie }))).toEqual({ code: "EMAIL_INVALID", field: "email" });
    expect(await errorOf(await post({ ...FORM, publicDisplayName: "   " }, { cookie }))).toEqual({ code: "PUBLIC_NAME_INVALID", field: "name" });
    expect(await errorOf(await post({ ...FORM, publicDisplayName: "あ".repeat(101) }, { cookie }))).toEqual({ code: "PUBLIC_NAME_INVALID", field: "name" });
    expect(await errorOf(await post({ ...FORM, publicDisplayNameEn: "a".repeat(101) }, { cookie }))).toEqual({ code: "PUBLIC_NAME_INVALID", field: "nameEn" });
    const stale = await post({ ...FORM, hostTermsVersion: "2020-01-01" }, { cookie });
    expect([stale.status, (await errorOf(stale)).code]).toEqual([409, "INVALID_INPUT"]);
    expect(state.identities.registerHostSelf).not.toHaveBeenCalled();
  });

  it("refuses an expired, forged, other-purpose or missing registration cookie when no host is signed in", async () => {
    const expired = await post(FORM, { cookie: registrationCookie({ expiresAt: Date.now() - 1000 }) });
    expect([expired.status, (await errorOf(expired)).code]).toEqual([401, "REGISTRATION_EXPIRED"]);
    const [name, value] = registrationCookie().split("=") as [string, string];
    const forged = await post(FORM, { cookie: `${name}=${value.slice(0, -4)}AAAA` });
    expect(forged.status).toBe(401);
    // Sealed for another purpose (the login cookie's key), it does not open.
    const other = cookieSealer(SECRET, "login").seal({ v: 1, u: NIHO_USER, t: Date.now() - 1000, x: Date.now() + 60_000 });
    expect((await post(FORM, { cookie: `${REGISTRATION_COOKIE}=${other}` })).status).toBe(401);
    expect((await post(FORM)).status).toBe(401);
    expect(state.identities.registerHostSelf).not.toHaveBeenCalled();
  });

  it("registers a writer or a member of another host through their session: a host is added to the account, no new session", async () => {
    state.accounts.readSession.mockResolvedValue(sessionRow());
    state.accounts.listProviderMemberships.mockResolvedValue([{ providerId: "prv_other", displayName: "別のホスト", memberRole: "COHOST", legacyProviderId: null }]);
    const response = await post(FORM, { cookie: `${ACCOUNT_SESSION_COOKIE}=${SESSION_TOKEN}` });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, redirect: `/host/home?providerId=${PROVIDER}` });
    expect(state.identities.registerHostSelfForAccount).toHaveBeenCalledWith(expect.objectContaining({ hostAccountId: HOST, providerKind: "PERSON", notificationEmail: "yuki@example.test" }));
    expect(state.identities.registerHostSelf).not.toHaveBeenCalled();
    expect(setCookies(response).has(ACCOUNT_SESSION_COOKIE)).toBe(false);

    state.identities.registerHostSelfForAccount.mockResolvedValueOnce({ kind: "owner-limit-reached" });
    expect((await errorOf(await post(FORM, { cookie: `${ACCOUNT_SESSION_COOKIE}=${SESSION_TOKEN}` }))).code).toBe("OWNER_LIMIT_REACHED");
    state.identities.registerHostSelfForAccount.mockResolvedValueOnce({ kind: "account-suspended" });
    expect((await errorOf(await post(FORM, { cookie: `${ACCOUNT_SESSION_COOKIE}=${SESSION_TOKEN}` }))).code).toBe("ACCOUNT_SUSPENDED");
  });

  it("does not add a second host for someone who already owns one (stage 2c)", async () => {
    state.accounts.readSession.mockResolvedValue(sessionRow());
    state.accounts.listProviderMemberships.mockResolvedValue([{ providerId: "prv_mine", displayName: "自分のホスト", memberRole: "OWNER", legacyProviderId: null }]);
    const response = await post(FORM, { cookie: `${ACCOUNT_SESSION_COOKIE}=${SESSION_TOKEN}` });
    expect([response.status, (await errorOf(response)).code]).toEqual([409, "ALREADY_REGISTERED"]);
    expect(state.identities.registerHostSelfForAccount).not.toHaveBeenCalled();
  });
});

type Tree = { type?: unknown; props?: Record<string, unknown> } | string | number | null | undefined | readonly Tree[];
/** The first element in a rendered-but-not-serialised tree whose type's name matches (a client component's props). */
function find(tree: Tree, name: string): Record<string, unknown> | null {
  if (!tree || typeof tree !== "object") return null;
  if (Array.isArray(tree)) { for (const item of tree) { const hit = find(item, name); if (hit) return hit; } return null; }
  const element = tree as { type?: unknown; props?: Record<string, unknown> };
  if (typeof element.type === "function" && (element.type as { name?: string }).name === name) return element.props ?? {};
  return find((element.props?.children ?? null) as Tree, name);
}
const target = async (render: () => Promise<unknown>) => { try { await render(); return "RENDERED"; } catch (error) { return (error as Error).message; } };

describe("/host/start", () => {
  it("is a 404 without the flag", async () => {
    state.config.hostSelfRegistrationEnabled = false;
    expect(await target(() => HostStartPage())).toBe("NOT_FOUND");
  });

  it("starts the form from the cookie with NIHO's name, and from nothing else sends the person to sign in", async () => {
    state.cookies[REGISTRATION_COOKIE] = registrationCookie().slice(REGISTRATION_COOKIE.length + 1);
    const props = find((await HostStartPage()) as Tree, "HostSelfRegistrationForm");
    expect(props).toMatchObject({ mode: "niho", nihoDisplayName: "森 ゆき", termsVersion: HOST_TERMS_VERSION });
    state.cookies = {};
    expect(await target(() => HostStartPage())).toBe("REDIRECT /host/auth/login?intent=register");
    state.cookies[REGISTRATION_COOKIE] = registrationCookie({ expiresAt: Date.now() - 1 }).slice(REGISTRATION_COOKIE.length + 1);
    expect(await target(() => HostStartPage())).toBe("REDIRECT /host/auth/login?intent=register");
  });

  it("adds a host to the account of a writer or a member, and sends an owner home", async () => {
    state.cookies[ACCOUNT_SESSION_COOKIE] = SESSION_TOKEN;
    state.accounts.readSession.mockResolvedValue(sessionRow());
    const props = find((await HostStartPage()) as Tree, "HostSelfRegistrationForm");
    expect(props).toMatchObject({ mode: "account", nihoDisplayName: null });
    state.accounts.listProviderMemberships.mockResolvedValue([{ providerId: "prv_mine", displayName: "自分のホスト", memberRole: "OWNER", legacyProviderId: null }]);
    expect(await target(() => HostStartPage())).toBe("REDIRECT /host/home");
  });
});

describe("/host/terms", () => {
  it("is a 404 without the flag, and says the wording waits for legal review with it", () => {
    state.config.hostSelfRegistrationEnabled = false;
    expect(() => HostTermsPage()).toThrow("NOT_FOUND");
    state.config.hostSelfRegistrationEnabled = true;
    const html = renderToStaticMarkup(HostTermsPage());
    expect(html).toContain("ホスト規約");
    expect(html).toContain("法務の確認待ち");
    expect(html).toContain(HOST_TERMS_VERSION);
    expect(html).toContain("公開の前に NIHO の審査はありません");
  });
});

describe("the form's first values", () => {
  it("uses NIHO's name only for a person, never overwrites what was typed, and leaves a business empty", () => {
    expect(nameAfterKindChange("PERSON", "森 ゆき", { name: "", edited: false })).toBe("森 ゆき");
    expect(nameAfterKindChange("BUSINESS", "森 ゆき", { name: "森 ゆき", edited: false })).toBe("");
    expect(nameAfterKindChange("PERSON", "森 ゆき", { name: "", edited: false })).toBe("森 ゆき");
    expect(nameAfterKindChange("BUSINESS", "森 ゆき", { name: "葉山クラフト", edited: true })).toBe("葉山クラフト");
    expect(nameAfterKindChange("PERSON", "森 ゆき", { name: "活動名", edited: true })).toBe("活動名");
    expect(nameAfterKindChange("PERSON", null, { name: "", edited: false })).toBe("");
  });
});
