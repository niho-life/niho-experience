import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LinkNihoIdentityResult, NihoIdentityStatus, UnlinkNihoIdentityResult } from "@niho-experience/experience-store";

/**
 * 設定 › ログイン情報 (Epic #591, #595): binding and unbinding a NIHO account, the re-login a sensitive change asks for, and
 * what the NIHO round trip does with a binding, against a synthetic NIHO and a stubbed store.
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
  /** When the person signed in at NIHO, as the exchange answer says (default: just now). */
  authTime: () => new Date().toISOString(),
  identities: null as {
    readNihoIdentity: ReturnType<typeof import("vitest").vi.fn>;
    linkNihoIdentity: ReturnType<typeof import("vitest").vi.fn>;
    unlinkNihoIdentity: ReturnType<typeof import("vitest").vi.fn>;
    startSessionForNihoIdentity: ReturnType<typeof import("vitest").vi.fn>;
  } | null,
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
  experiencePool: () => null,
  hostSalesRepository: () => null,
  experiencePublicationRepository: () => null,
  payoutAccountConsents: () => null,
}));

import { POST as nihoIdentity } from "@/app/(host)/host/api/niho-identity/route";
import { POST as payoutConsent } from "@/app/(host)/host/api/payout-account-consent/route";
import { GET as login } from "@/app/(host)/host/auth/login/route";
import { GET as callback } from "@/app/(host)/host/auth/callback/route";
import { hostStripeReauthHref } from "@/host/stripe-login-server";
import { HostNihoAccountRow } from "@/components/host/HostNihoAccountRow";
import { cookieSealer } from "./cookie-seal";
import { NIHO_IDENTITY_OUTCOMES } from "./niho-identity";
import { hostAccountSettingsPath, hostReturnPathOrNull } from "./routes";
import { ACCOUNT_SESSION_COOKIE, decodeLoginState, LOGIN_COOKIE } from "./session";

const SITE = state.config.siteUrl;
const DAY = 86_400_000;
const HOST = `hst_${"d".repeat(32)}`;
const REF = "0f8fad5b-d9cb-469f-a165-70867728950e";
const NIHO_USER = "niho-user-synthetic-link";
const ACCESS = "niho-access-token-link";
const CONNECTION = "conn_synthetic_link";
const SESSION_TOKEN = "sessionToken".padEnd(43, "x");
const SETTINGS = "/host/settings?providerId=p_1&section=account";
const sameOrigin = { origin: SITE, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" };

const stored = (authenticatedAgoMs: number) => ({
  hostAccountId: HOST, email: "synthetic-host@example.test", sessionRef: REF,
  authenticatedAtUtc: new Date(Date.now() - authenticatedAgoMs).toISOString(),
  idleExpiresAtUtc: new Date(Date.now() + 14 * DAY).toISOString(), absoluteExpiresAtUtc: new Date(Date.now() + 29 * DAY).toISOString(),
});
const bound: NihoIdentityStatus = { linkedAtUtc: "2026-11-10T00:00:00.000Z", lastLoginAtUtc: "2026-11-13T00:00:00.000Z", linkedVia: "SETTINGS" };

const calls: { url: URL; init: RequestInit }[] = [];
beforeEach(() => {
  calls.length = 0;
  Object.assign(state.config, { hostConsoleEnabled: true, hostAccountsEnabled: true, hostNihoLoginEnabled: true, apiMode: "http" });
  state.cookies = { [ACCOUNT_SESSION_COOKIE]: SESSION_TOKEN };
  state.accounts = { readSession: vi.fn(async () => stored(60_000)), revokeSession: vi.fn(async () => true) };
  state.identities = {
    readNihoIdentity: vi.fn(async (): Promise<NihoIdentityStatus | null> => null),
    linkNihoIdentity: vi.fn(async (): Promise<LinkNihoIdentityResult> => ({ kind: "linked" })),
    unlinkNihoIdentity: vi.fn(async (): Promise<UnlinkNihoIdentityResult> => ({ kind: "unlinked" })),
    startSessionForNihoIdentity: vi.fn(async () => ({ kind: "ok" as const, sessionToken: "newSessionToken".padEnd(43, "x"), sessionRef: "1f8fad5b-d9cb-469f-a165-70867728950e", hostAccountId: HOST, absoluteExpiresAtUtc: new Date(Date.now() + 30 * DAY).toISOString() })),
  };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    if (url.pathname === "/api/auth/app-connect/exchange") return json(200, { accessToken: ACCESS, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), refreshToken: "refresh-link", connectionId: CONNECTION, connectionExpiresAt: new Date(Date.now() + 90 * DAY).toISOString(), user: { displayName: "合成", iconImage: null }, authTime: state.authTime() });
    if (url.pathname === "/api/experience-host/identity") return json(200, { nihoUserId: NIHO_USER, accountStatus: "ACTIVE" });
    if (init.method === "DELETE") return new Response(null, { status: 204 });
    return json(404, {});
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const post = (body: string, headers: Record<string, string> = sameOrigin) => new NextRequest(`${SITE}/host/api/niho-identity`, { method: "POST", headers: { ...headers, cookie: `${ACCOUNT_SESSION_COOKIE}=${SESSION_TOKEN}` }, body });
const loginState = (response: Response) => {
  const header = response.headers.getSetCookie().find((entry) => entry.startsWith(`${LOGIN_COOKIE}=`))!;
  return decodeLoginState(cookieSealer(state.config.hostSessionSecret, "login"), header.split(";")[0]!.slice(LOGIN_COOKIE.length + 1), Date.now());
};
const location = (response: Response) => response.headers.get("location")!;
const loginStateOf = loginState;

describe("the return pages", () => {
  it("allows 設定 › ログイン情報 with only a provider as a return, and nothing wider", () => {
    expect(hostReturnPathOrNull(SETTINGS)).toBe(SETTINGS);
    expect(hostReturnPathOrNull("/host/settings?section=account")).toBe("/host/settings?section=account");
    expect(hostAccountSettingsPath("p_1")).toBe(SETTINGS);
    for (const value of [
      "/host/settings?section=team", "/host/settings?providerId=p_1&section=account&x=1", "/host/settings?section=account#settings-payout",
      "/host/settings?providerId=bad%20id&section=account", "https://evil.example.test/host/settings?section=account",
    ]) expect(hostReturnPathOrNull(value), value).toBeNull();
  });
});

describe("binding a NIHO account (設定)", () => {
  it("sends a host with a recent sign-in to NIHO, asking NIHO to sign them in again, and comes back to 設定", async () => {
    const response = await nihoIdentity(post("action=link&providerId=p_1"));
    expect(response.status).toBe(303);
    const to = new URL(location(response));
    expect(to.origin).toBe("https://niho.example.test");
    expect(to.searchParams.get("audience")).toBe("host");
    expect(to.searchParams.get("max_age")).toBe("300");
    expect(loginState(response)).toMatchObject({ purpose: "link", providerId: "p_1", returnPath: SETTINGS, hostAccountId: HOST });
    expect(state.identities!.linkNihoIdentity).not.toHaveBeenCalled();
  });

  it("asks a host whose sign-in is old to sign in again first (the emailed link: nothing is bound yet)", async () => {
    state.accounts!.readSession.mockResolvedValue(stored(40 * 60_000));
    const response = await nihoIdentity(post("action=link&providerId=p_1"));
    expect(location(response)).toBe(`/host/auth/sign-in?reauth=1&next=${encodeURIComponent(SETTINGS)}`);
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it("does not bind twice, and refuses a cross-site post, a wrong form and a switched-off flag", async () => {
    state.identities!.readNihoIdentity.mockResolvedValue(bound);
    expect(location(await nihoIdentity(post("action=link&providerId=p_1")))).toBe(`${SETTINGS}&niho=already-linked`);
    expect((await nihoIdentity(post("action=link", { ...sameOrigin, origin: "https://evil.example.test", "sec-fetch-site": "cross-site" }))).status).toBe(403);
    expect((await nihoIdentity(post("action=nope"))).status).toBe(400);
    expect((await nihoIdentity(post("action=link&providerId=bad%20id"))).status).toBe(400);
    expect((await nihoIdentity(post("action=link&extra=1"))).status).toBe(400);
    state.config.hostNihoLoginEnabled = false;
    expect((await nihoIdentity(post("action=link"))).status).toBe(404);
  });

  it("sends nobody without a session to NIHO", async () => {
    state.accounts!.readSession.mockResolvedValue(null);
    expect(location(await nihoIdentity(post("action=link")))).toBe("/host/auth/sign-in");
  });
});

describe("the NIHO round trip of a binding", () => {
  async function comeBack(search = "", beforeReturn?: () => void) {
    const started = await nihoIdentity(post("action=link&providerId=p_1"));
    beforeReturn?.();
    const stateValue = new URL(location(started)).searchParams.get("state");
    const cookie = started.headers.getSetCookie().find((entry) => entry.startsWith(`${LOGIN_COOKIE}=`))!.split(";")[0]!;
    return callback(new NextRequest(`${SITE}/host/auth/callback?code=code-1&state=${stateValue}${search}`, { headers: { cookie: `${cookie}; ${ACCOUNT_SESSION_COOKIE}=${SESSION_TOKEN}` } }));
  }

  it("binds the NIHO account to the open session's host account, opens no session, and ends the connection", async () => {
    const response = await comeBack();
    expect(location(response)).toBe(`${SETTINGS}&niho=linked`);
    expect(state.identities!.linkNihoIdentity).toHaveBeenCalledTimes(1);
    const asked = state.identities!.linkNihoIdentity.mock.calls[0]![0] as { hostAccountId: string; nihoUserId: string; proof: { kind: string; sessionRef: string; nihoAuthenticatedAtUtc: string }; nowUtc: string };
    expect(asked).toMatchObject({ hostAccountId: HOST, nihoUserId: NIHO_USER, proof: { kind: "SESSION", sessionRef: REF } });
    // The store is told when the person signed in at NIHO (NIHO's authTime), which it holds against the recent-sign-in window.
    expect(Math.abs(Date.parse(asked.proof.nihoAuthenticatedAtUtc) - Date.parse(asked.nowUtc))).toBeLessThan(5_000);
    // No new session, no change to the one that is open, and the connection ends.
    expect(state.identities!.startSessionForNihoIdentity).not.toHaveBeenCalled();
    expect(response.headers.getSetCookie().some((entry) => entry.startsWith(`${ACCOUNT_SESSION_COOKIE}=`))).toBe(false);
    expect(calls.filter((call) => call.init.method === "DELETE")).toHaveLength(1);
    expect([location(response), ...response.headers.getSetCookie()].join("\n")).not.toContain(NIHO_USER);
  });

  it("passes NIHO's authTime to the store as it is, so an old NIHO sign-in is the store's to refuse", async () => {
    const old = new Date(Date.now() - 45 * 60_000).toISOString();
    state.authTime = () => old;
    state.identities!.linkNihoIdentity.mockResolvedValueOnce({ kind: "recent-authentication-required" });
    expect(location(await comeBack())).toBe(`${SETTINGS}&niho=reauth`);
    expect((state.identities!.linkNihoIdentity.mock.calls[0]![0] as { proof: { nihoAuthenticatedAtUtc: string } }).proof.nihoAuthenticatedAtUtc).toBe(old);
    state.authTime = () => new Date().toISOString();
  });

  it("fails closed without NIHO's sign-in time: nothing is bound", async () => {
    state.authTime = () => undefined as unknown as string;
    expect(location(await comeBack())).toBe(`${SETTINGS}&niho=unverified`);
    state.authTime = () => "not a time";
    expect(location(await comeBack())).toBe(`${SETTINGS}&niho=unverified`);
    expect(state.identities!.linkNihoIdentity).not.toHaveBeenCalled();
    state.authTime = () => new Date().toISOString();
  });

  it("tells what the store said, and never a NIHO user ID", async () => {
    const cases: [LinkNihoIdentityResult, string][] = [
      [{ kind: "already-linked" }, "already-linked"],
      [{ kind: "identity-in-use" }, "identity-in-use"],
      [{ kind: "account-has-identity" }, "account-has-identity"],
      [{ kind: "recent-authentication-required" }, "reauth"],
      [{ kind: "host-account-not-active" }, "unavailable"],
    ];
    for (const [result, outcome] of cases) {
      state.identities!.linkNihoIdentity.mockResolvedValueOnce(result);
      expect(location(await comeBack()), outcome).toBe(`${SETTINGS}&niho=${outcome}`);
    }
    state.identities!.linkNihoIdentity.mockRejectedValueOnce(new Error(`database said ${NIHO_USER}`));
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(location(await comeBack())).toBe(`${SETTINGS}&niho=unavailable`);
    expect(errors.mock.calls.flat().join(" ")).not.toContain(NIHO_USER);
  });

  it("binds only the host account that asked: a session switched to another account meanwhile is refused", async () => {
    const other = `hst_${"f".repeat(32)}`;
    const response = await comeBack("", () => state.accounts!.readSession.mockResolvedValue({ ...stored(60_000), hostAccountId: other }));
    expect(location(response)).toBe(`${SETTINGS}&niho=switched`);
    expect(state.identities!.linkNihoIdentity).not.toHaveBeenCalled();
    expect(loginStateOf(await nihoIdentity(post("action=link&providerId=p_1")))).toMatchObject({ hostAccountId: other });
    // Refused before NIHO is called at all: no code is exchanged, so no connection exists to end.
    expect(calls).toEqual([]);
  });

  it("goes back to 設定 when NIHO denies or fails, and asks for a sign-in when the session ended meanwhile", async () => {
    expect(location(await comeBack("&error=access_denied"))).toBe(`${SETTINGS}&niho=denied`);
    expect(location(await comeBack("", () => state.accounts!.readSession.mockResolvedValue(null)))).toBe("/host/auth/error?reason=expired");
    // Nothing was bound for a session that no longer exists.
    expect(state.identities!.linkNihoIdentity).not.toHaveBeenCalled();
  });
});

describe("re-login for a sensitive change", () => {
  it("goes to NIHO again even when signed in, asks for a recent sign-in, and opens a new session on return", async () => {
    const response = await login(new NextRequest(`${SITE}/host/auth/login?reauth=1&returnTo=${encodeURIComponent(SETTINGS)}`, { headers: { cookie: `${ACCOUNT_SESSION_COOKIE}=${SESSION_TOKEN}` } }));
    expect(new URL(location(response)).searchParams.get("max_age")).toBe("300");
    expect(loginState(response)).toMatchObject({ returnPath: SETTINGS });
    expect(loginState(response)?.purpose).toBeUndefined();
    // Without reauth, a signed-in host is not sent to NIHO.
    const plain = await login(new NextRequest(`${SITE}/host/auth/login`, { headers: { cookie: `${ACCOUNT_SESSION_COOKIE}=${SESSION_TOKEN}` } }));
    expect(location(plain)).toBe("/host/home");

    const stateValue = new URL(location(response)).searchParams.get("state");
    const cookie = response.headers.getSetCookie().find((entry) => entry.startsWith(`${LOGIN_COOKIE}=`))!.split(";")[0]!;
    const back = await callback(new NextRequest(`${SITE}/host/auth/callback?code=code-1&state=${stateValue}`, { headers: { cookie: `${cookie}; ${ACCOUNT_SESSION_COOKIE}=${SESSION_TOKEN}` } }));
    expect(location(back)).toBe(SETTINGS);
    expect(state.identities!.startSessionForNihoIdentity).toHaveBeenCalledTimes(1);
    // The session this browser held ends: the new one replaces it.
    expect(state.accounts!.revokeSession).toHaveBeenCalledWith(expect.objectContaining({ sessionToken: SESSION_TOKEN }));
  });

  it("sends a host with a bound NIHO account whose sign-in is old to NIHO, from 受取口座, and everyone else to the email form", async () => {
    state.accounts!.readSession.mockResolvedValue(stored(40 * 60_000));
    const consent = () => payoutConsent(new NextRequest(`${SITE}/host/api/payout-account-consent`, { method: "POST", headers: { ...sameOrigin, cookie: `${ACCOUNT_SESSION_COOKIE}=${SESSION_TOKEN}` }, body: "providerId=p_1&action=withdraw&accountLast4=1234" }));
    const payoutPath = "/host/settings?providerId=p_1#settings-payout";
    expect(location(await consent())).toBe(`/host/auth/sign-in?reauth=1&next=${encodeURIComponent(payoutPath)}`);
    state.identities!.readNihoIdentity.mockResolvedValue(bound);
    expect(location(await consent())).toBe(`/host/auth/login?reauth=1&returnTo=${encodeURIComponent(payoutPath)}`);
    // A fresh sign-in is not asked again (the form goes on to the account checks, not to a sign-in).
    state.accounts!.readSession.mockResolvedValue(stored(60_000));
    expect(location(await consent())).not.toContain("reauth=1");
    // With the NIHO account login off, nothing is read from the bindings.
    state.config.hostNihoLoginEnabled = false;
    state.accounts!.readSession.mockResolvedValue(stored(40 * 60_000));
    state.identities!.readNihoIdentity.mockClear();
    expect(location(await consent())).toBe(`/host/auth/sign-in?reauth=1&next=${encodeURIComponent(payoutPath)}`);
    expect(state.identities!.readNihoIdentity).not.toHaveBeenCalled();
  });

  it("sends the Stripe dashboard button the same way, and leaves everyone else to Stripe's own sign-in", async () => {
    state.accounts!.readSession.mockResolvedValue(stored(40 * 60_000));
    expect(await hostStripeReauthHref("p_1")).toBeNull();
    state.identities!.readNihoIdentity.mockResolvedValue(bound);
    expect(await hostStripeReauthHref("p_1")).toBe(`/host/auth/login?reauth=1&returnTo=${encodeURIComponent("/host/settings?providerId=p_1#settings-payout")}`);
    state.accounts!.readSession.mockResolvedValue(stored(60_000));
    expect(await hostStripeReauthHref("p_1")).toBeNull();
    state.config.hostNihoLoginEnabled = false;
    state.accounts!.readSession.mockResolvedValue(stored(40 * 60_000));
    expect(await hostStripeReauthHref("p_1")).toBeNull();
  });
});

describe("unbinding a NIHO account (設定)", () => {
  const unlink = () => nihoIdentity(post("action=unlink&providerId=p_1"));

  it("unbinds with the host's own session, saying the email link remains a way in", async () => {
    expect(location(await unlink())).toBe(`${SETTINGS}&niho=unlinked`);
    expect(state.identities!.unlinkNihoIdentity).toHaveBeenCalledWith(expect.objectContaining({
      hostAccountId: HOST,
      proof: { kind: "SESSION", sessionRef: REF, emailSignInAvailable: true },
    }));
  });

  it("tells a refusal for the last way in, nothing bound, and an old sign-in (NIHO again for a bound account)", async () => {
    state.identities!.unlinkNihoIdentity.mockResolvedValueOnce({ kind: "last-sign-in-method" });
    expect(location(await unlink())).toBe(`${SETTINGS}&niho=last-method`);
    state.identities!.unlinkNihoIdentity.mockResolvedValueOnce({ kind: "not-linked" });
    expect(location(await unlink())).toBe(`${SETTINGS}&niho=not-linked`);
    state.identities!.unlinkNihoIdentity.mockResolvedValueOnce({ kind: "recent-authentication-required" });
    state.identities!.readNihoIdentity.mockResolvedValue(bound);
    expect(location(await unlink())).toBe(`/host/auth/login?reauth=1&returnTo=${encodeURIComponent(SETTINGS)}`);
    state.identities!.unlinkNihoIdentity.mockRejectedValueOnce(new Error("boom"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(location(await unlink())).toBe(`${SETTINGS}&niho=unavailable`);
  });
});

describe("設定 › ログイン情報's NIHO account row", () => {
  const html = (status: Parameters<typeof HostNihoAccountRow>[0]["status"], outcome: Parameters<typeof HostNihoAccountRow>[0]["outcome"] = null) =>
    renderToStaticMarkup(HostNihoAccountRow({ providerId: "p_1", status, outcome }));

  it("offers the binding to a host with none, and the unbinding (asked first) to a host with one", () => {
    const none = html(null);
    expect(none).toContain("結び付けていません");
    expect(none).toContain('action="/host/api/niho-identity"');
    expect(none).toContain('name="action" value="link"');
    expect(none).toContain('name="providerId" value="p_1"');
    expect(none).toContain("NIHO アカウントを結び付ける");
    expect(none).not.toContain('value="unlink"');

    const some = html(bound);
    expect(some).toContain("結び付け済み");
    expect(some).toContain("2026/11/10");
    expect(some).toContain("2026/11/13");
    expect(some).toContain("<details");
    expect(some).toContain('name="action" value="unlink"');
    expect(some).not.toContain('value="link"');
    // The row never names the NIHO account.
    expect(some).not.toMatch(/niho-user|conn_|hst_/);
  });

  it("tells what the last attempt did, as a status or an alert, and a store failure as an alert", () => {
    for (const [outcome, { tone, text }] of Object.entries(NIHO_IDENTITY_OUTCOMES)) {
      const markup = html(null, outcome as keyof typeof NIHO_IDENTITY_OUTCOMES);
      expect(markup, outcome).toContain(text);
      expect(markup, outcome).toContain(tone === "problem" ? 'role="alert"' : 'role="status"');
    }
    expect(html("error")).toContain("結び付けの状態を確認できません");
    expect(html("error")).not.toContain("<form");
  });
});
