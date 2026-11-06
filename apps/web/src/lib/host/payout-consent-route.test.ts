import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StoreAccessDeniedError, StoreConflictError, StoreValidationError, type HostSession as StoredHostSession } from "@niho-experience/experience-store";

/** 受取口座の利用同意 (ADR 0003 slice 3): the consent route and the sign-in it asks for, against stubbed stores. Synthetic data only. */
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
    experiencePayoutAccountConsentVersion: "payout-v1",
  },
  accounts: null as unknown,
  publications: null as unknown,
  consents: null as unknown,
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: state.config, isPreview: false }));
vi.mock("@/lib/experience/store-server", () => ({
  hostAccounts: () => state.accounts,
  experiencePool: () => null,
  experiencePublicationRepository: () => state.publications,
  payoutAccountConsents: () => state.consents,
}));

import { POST as consentRoute } from "@/app/(host)/host/api/payout-account-consent/route";
import { POST as requestLink } from "@/app/(host)/host/auth/email/route";
import { GET as openPage, POST as openLink } from "@/app/(host)/host/auth/open/route";
import { hostReturnPathOrNull } from "./routes";
import { ACCOUNT_SESSION_COOKIE, LINK_BINDING_COOKIE, RETURN_PATH_COOKIE } from "./session";

const SITE = state.config.siteUrl;
const form = { origin: SITE, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" };
const secret = (label: string) => label.padEnd(43, "x");
const SESSION_TOKEN = secret("sessionToken");
const BINDING = secret("bindingValue");
const HOST = `hst_${"a".repeat(32)}`;
const PROVIDER = "provider-supper";
const ACCOUNT = "acct_SyntheticHostSeller01";
const profile = {
  providerId: PROVIDER, legacyProviderId: null, providerDisplayName: "Synthetic Supper Club",
  sellerNihoAccountRef: `sel_${"b".repeat(32)}`, stripeConnectAccountRef: ACCOUNT, sellerDisplayName: "Synthetic Legal Seller KK",
};
const MINUTE = 60_000;

const stored = (signedInMinutesAgo: number): StoredHostSession => ({
  hostAccountId: HOST,
  email: "owner@example.test",
  sessionRef: "0f8fad5b-d9cb-469f-a165-70867728950e",
  authenticatedAtUtc: new Date(Date.now() - signedInMinutesAgo * MINUTE).toISOString(),
  idleExpiresAtUtc: new Date(Date.now() + 14 * 24 * 60 * MINUTE).toISOString(),
  absoluteExpiresAtUtc: new Date(Date.now() + 29 * 24 * 60 * MINUTE).toISOString(),
});

let accounts: { readSession: ReturnType<typeof vi.fn>; requestLogin: ReturnType<typeof vi.fn>; consumeLogin: ReturnType<typeof vi.fn>; revokeSession: ReturnType<typeof vi.fn> };
let publications: { currentHostAccountSellerProfile: ReturnType<typeof vi.fn> };
let consents: { record: ReturnType<typeof vi.fn>; revoke: ReturnType<typeof vi.fn> };

const body = (fields: Record<string, string>) => new URLSearchParams(fields).toString();
const consentForm = { providerId: PROVIDER, action: "consent", accountLast4: ACCOUNT.slice(-4), consentVersion: "payout-v1", accepted: "yes" };
const withdrawForm = { providerId: PROVIDER, action: "withdraw", accountLast4: ACCOUNT.slice(-4) };
const post = (fields: Record<string, string> | string, headers: Record<string, string> = {}) => consentRoute(new NextRequest(`${SITE}/host/api/payout-account-consent`, {
  method: "POST",
  headers: { ...form, cookie: `${ACCOUNT_SESSION_COOKIE}=${SESSION_TOKEN}`, ...headers },
  body: typeof fields === "string" ? fields : body(fields),
}));
const settingsWith = (payout: string) => `/host/settings?providerId=${PROVIDER}&payout=${payout}#settings-payout`;

beforeEach(() => {
  Object.assign(state.config, { hostConsoleEnabled: true, hostAccountsEnabled: true, experiencePayoutAccountConsentVersion: "payout-v1" });
  accounts = {
    readSession: vi.fn(async () => stored(5)),
    requestLogin: vi.fn(async () => ({ kind: "accepted" })),
    consumeLogin: vi.fn(async () => ({ kind: "ok", sessionToken: SESSION_TOKEN, sessionRef: "0f8fad5b-d9cb-469f-a165-70867728950e", hostAccountId: HOST, absoluteExpiresAtUtc: new Date(Date.now() + 30 * 24 * 60 * MINUTE).toISOString() })),
    revokeSession: vi.fn(async () => true),
  };
  publications = { currentHostAccountSellerProfile: vi.fn(async () => ({ kind: "ready", profile, hostAccountActive: true })) };
  consents = { record: vi.fn(async () => ({ outcome: "RECORDED" })), revoke: vi.fn(async () => ({ outcome: "REVOKED", stoppedPublications: 1 })) };
  Object.assign(state, { accounts, publications, consents });
});

describe("POST /host/api/payout-account-consent", () => {
  it("records the OWNER's consent to the registered account at the configured version, and comes back to 受取口座", async () => {
    const response = await post(consentForm);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(settingsWith("consented"));
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(publications.currentHostAccountSellerProfile).toHaveBeenCalledWith(HOST);
    expect(consents.record).toHaveBeenCalledWith(
      { providerId: PROVIDER, nihoUserId: HOST },
      { stripeConnectAccountRef: ACCOUNT, consentVersion: "payout-v1", nowUtc: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/) },
    );
  });

  it("withdraws the consent", async () => {
    const response = await post(withdrawForm);
    expect(response.headers.get("location")).toBe(settingsWith("withdrawn"));
    expect(consents.revoke).toHaveBeenCalledWith({ providerId: PROVIDER, nihoUserId: HOST }, { nowUtc: expect.any(String) });
    expect(consents.record).not.toHaveBeenCalled();
  });

  it("sends a session older than 30 minutes, or none, to sign in again and come back, changing nothing", async () => {
    for (const session of [stored(31), null]) {
      accounts.readSession.mockResolvedValueOnce(session);
      const response = await post(consentForm);
      expect(response.status).toBe(303);
      const location = new URL(response.headers.get("location")!, SITE);
      expect(location.pathname).toBe("/host/auth/sign-in");
      expect(location.searchParams.get("reauth")).toBe("1");
      expect(location.searchParams.get("next")).toBe(`/host/settings?providerId=${PROVIDER}#settings-payout`);
      expect(hostReturnPathOrNull(location.searchParams.get("next"))).toBe(location.searchParams.get("next"));
    }
    // No cookie at all.
    const anonymous = await post(withdrawForm, { cookie: "" });
    expect(new URL(anonymous.headers.get("location")!, SITE).pathname).toBe("/host/auth/sign-in");
    expect(consents.record).not.toHaveBeenCalled();
    expect(consents.revoke).not.toHaveBeenCalled();
    // Within 30 minutes it goes through.
    accounts.readSession.mockResolvedValueOnce(stored(29));
    expect((await post(withdrawForm)).headers.get("location")).toBe(settingsWith("withdrawn"));
  });

  it("refuses cross-site posts, other forms, and the flag being off", async () => {
    expect((await post(consentForm, { origin: "https://evil.example.test", "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await post(consentForm, { "sec-fetch-site": "same-site" })).status).toBe(403);
    expect((await post(JSON.stringify(consentForm), { "content-type": "application/json" })).status).toBe(415);
    expect((await post({ ...consentForm, stripeConnectAccountRef: "acct_attacker000001" })).status).toBe(400);
    expect((await post({ ...consentForm, action: "share" })).status).toBe(400);
    expect((await post({ ...withdrawForm, accepted: "yes" })).status).toBe(400);
    expect((await post({ ...consentForm, providerId: "../x" })).status).toBe(400);
    expect((await post(`${body(consentForm)}&action=withdraw`)).status).toBe(400);
    state.config.hostAccountsEnabled = false;
    expect((await post(consentForm)).status).toBe(404);
    expect(consents.record).not.toHaveBeenCalled();
    expect(accounts.readSession).not.toHaveBeenCalled();
  });

  it("asks for the checkbox and the current version, and for the account that was shown", async () => {
    const unchecked = Object.fromEntries(Object.entries(consentForm).filter(([key]) => key !== "accepted"));
    expect((await post(unchecked)).headers.get("location")).toBe(settingsWith("unchecked"));
    expect((await post({ ...consentForm, accepted: "no" })).headers.get("location")).toBe(settingsWith("unchecked"));
    expect((await post({ ...consentForm, consentVersion: "payout-v0" })).headers.get("location")).toBe(settingsWith("changed"));
    expect((await post({ ...consentForm, accountLast4: "9999" })).headers.get("location")).toBe(settingsWith("changed"));
    state.config.experiencePayoutAccountConsentVersion = "";
    expect((await post(consentForm)).headers.get("location")).toBe(settingsWith("changed"));
    expect(consents.record).not.toHaveBeenCalled();
  });

  it("refuses anyone who is not this provider's OWNER with a registered seller, and maps store refusals", async () => {
    for (const [resolved, outcome] of [
      [{ kind: "none" }, "forbidden"],
      [{ kind: "ambiguous" }, "forbidden"],
      [{ kind: "setup-required", providerId: PROVIDER }, "changed"],
      [{ kind: "ready", profile: { ...profile, providerId: "provider-other" }, hostAccountActive: true }, "forbidden"],
    ] as const) {
      publications.currentHostAccountSellerProfile.mockResolvedValueOnce(resolved);
      expect((await post(consentForm)).headers.get("location"), JSON.stringify(resolved)).toBe(settingsWith(outcome));
    }
    expect(consents.record).not.toHaveBeenCalled();
    consents.record.mockRejectedValueOnce(new StoreAccessDeniedError());
    expect((await post(consentForm)).headers.get("location")).toBe(settingsWith("forbidden"));
    consents.record.mockRejectedValueOnce(new StoreConflictError("The provider's payout account changed; read it again."));
    expect((await post(consentForm)).headers.get("location")).toBe(settingsWith("changed"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    consents.revoke.mockRejectedValueOnce(new Error(`db down near ${ACCOUNT}`));
    expect((await post(withdrawForm)).headers.get("location")).toBe(settingsWith("unavailable"));
    expect(errors.mock.calls.flat().join(" ")).not.toContain(ACCOUNT);
    publications.currentHostAccountSellerProfile.mockRejectedValueOnce(new Error("db down"));
    expect((await post(consentForm)).headers.get("location")).toBe(settingsWith("unavailable"));
    accounts.readSession.mockRejectedValueOnce(new Error("db down"));
    expect((await post(consentForm)).headers.get("location")).toBe(settingsWith("unavailable"));
    errors.mockRestore();
  });
});

describe("the sign-in a sensitive change asks for comes back to 受取口座", () => {
  const next = `/host/settings?providerId=${PROVIDER}#settings-payout`;

  it("accepts only 設定 › 受取口座 with at most its providerId as the return page", () => {
    expect(hostReturnPathOrNull(next)).toBe(next);
    expect(hostReturnPathOrNull("/host/settings#settings-payout")).toBe("/host/settings#settings-payout");
    for (const bad of [
      "/host/settings", "/host/settings?providerId=p#other", "/host/home#settings-payout", "https://evil.example.test/host/settings#settings-payout",
      "//evil.example.test/host/settings#settings-payout", "/host/settings?providerId=p&x=1#settings-payout", "/host/settings?providerId=../x#settings-payout",
      "/host/\\evil#settings-payout", "/host/../admin#settings-payout", 42, null,
    ]) expect(hostReturnPathOrNull(bad), String(bad)).toBeNull();
  });

  it("also accepts a product operator's invitation page, exactly, so a sign-in from it returns there", () => {
    const invitation = "/host/invitations/8f14e45f-ceea-467a-9575-1f2a3b4c5d6e";
    expect(hostReturnPathOrNull(invitation)).toBe(invitation);
    for (const bad of [
      "/host/invitations/not-a-uuid", "/host/invitations/8f14e45f-ceea-467a-9575-1f2a3b4c5d6e?x=1", "/host/invitations/8f14e45f-ceea-467a-9575-1f2a3b4c5d6e#x",
      "/host/invitations/8f14e45f-ceea-467a-9575-1f2a3b4c5d6e/accept", "/host/invitations/", "/host/invitations/%2e%2e%2fadmin",
      "//evil.example.test/host/invitations/8f14e45f-ceea-467a-9575-1f2a3b4c5d6e",
    ]) expect(hostReturnPathOrNull(bad), bad).toBeNull();
  });

  it("keeps the return page beside the link cookie, and the emailed link's page opens it", async () => {
    const emailed = await requestLink(new NextRequest(`${SITE}/host/auth/email`, { method: "POST", headers: form, body: body({ email: "owner@example.test", next }) }));
    expect(emailed.status).toBe(303);
    const cookies = new Map(emailed.headers.getSetCookie().map((header) => {
      const [pair = "", ...attributes] = header.split("; ");
      return [pair.slice(0, pair.indexOf("=")), { value: pair.slice(pair.indexOf("=") + 1), attributes: attributes.join("; ") }] as const;
    }));
    const kept = cookies.get(RETURN_PATH_COOKIE)!;
    // The 「メールを確認してください」 page is still this sign-in's: it keeps the return page (and, when asked, why).
    expect(new URL(emailed.headers.get("location")!, SITE).searchParams.get("next")).toBe(next);
    const reauthSent = await requestLink(new NextRequest(`${SITE}/host/auth/email`, { method: "POST", headers: form, body: body({ email: "owner@example.test", next, reauth: "1" }) }));
    const reauthLocation = new URL(reauthSent.headers.get("location")!, SITE);
    expect([reauthLocation.searchParams.get("sent"), reauthLocation.searchParams.get("reauth"), reauthLocation.searchParams.get("next")]).toEqual(["1", "1", next]);
    // A malformed address goes back to the same re-sign-in form, not to the home.
    accounts.requestLogin.mockRejectedValueOnce(new StoreValidationError("email must be an email address of 3-254 characters."));
    const mistyped = await requestLink(new NextRequest(`${SITE}/host/auth/email`, { method: "POST", headers: form, body: body({ email: "not an address", next, reauth: "1" }) }));
    const mistypedLocation = new URL(mistyped.headers.get("location")!, SITE);
    expect([mistypedLocation.pathname, mistypedLocation.searchParams.get("error"), mistypedLocation.searchParams.get("reauth"), mistypedLocation.searchParams.get("next")]).toEqual(["/host/auth/sign-in", "email", "1", next]);
    expect(kept.attributes).toMatch(/Path=\/host\/auth(;|$)/);
    expect(kept.attributes).toMatch(/HttpOnly/);
    expect(kept.attributes).toMatch(/Max-Age=900/);
    // A form with a page that is not allowlisted is refused; without one, an old return page is cleared.
    expect((await requestLink(new NextRequest(`${SITE}/host/auth/email`, { method: "POST", headers: form, body: body({ email: "owner@example.test", next: "/host/home" }) }))).status).toBe(400);
    const plain = await requestLink(new NextRequest(`${SITE}/host/auth/email`, { method: "POST", headers: form, body: body({ email: "owner@example.test" }) }));
    expect(plain.headers.getSetCookie().some((header) => header.startsWith(`${RETURN_PATH_COOKIE}=;`) && header.includes("Max-Age=0"))).toBe(true);

    const page = await openPage(new NextRequest(`${SITE}/host/auth/open`, { headers: { cookie: `${RETURN_PATH_COOKIE}=${kept.value}` } })).text();
    expect(page).toContain(`location.replace(${JSON.stringify(next)})`);
    const script = /<script>([\s\S]*)<\/script>/.exec(page)![1]!;
    expect(() => new Function(script)).not.toThrow();
    // A forged cookie opens the home.
    const forged = await openPage(new NextRequest(`${SITE}/host/auth/open`, { headers: { cookie: `${RETURN_PATH_COOKIE}=${Buffer.from("https://evil.example.test/").toString("base64url")}` } })).text();
    expect(forged).toContain('location.replace("/host/home")');
    expect(forged).not.toContain("evil.example.test");

    // Opening the link clears the return page with the link cookie.
    const opened = await openLink(new NextRequest(`${SITE}/host/auth/open`, { method: "POST", headers: { ...form, cookie: `${LINK_BINDING_COOKIE}=${BINDING}; ${RETURN_PATH_COOKIE}=${kept.value}` }, body: `t=${secret("linkToken")}` }));
    expect(opened.status).toBe(204);
    expect(opened.headers.getSetCookie().some((header) => header.startsWith(`${RETURN_PATH_COOKIE}=;`) && header.includes("Max-Age=0"))).toBe(true);
  });
});
