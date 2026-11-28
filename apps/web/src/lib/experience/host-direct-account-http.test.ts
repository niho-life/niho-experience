import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/* 自分の Stripe アカウントの route (#726, 3c-1): flag, same origin, 30 minutes, OWNER of the named host. The flow itself is stubbed. */
const state = vi.hoisted(() => ({
  config: { hostConsoleEnabled: true, hostAccountsEnabled: true, hostStandardOnboardingEnabled: true, experiencePayoutAccountConsentVersion: "consent-v1" },
  session: null as null | { hostAccountId: string; authenticatedAtUtc: string },
  recent: true,
  memberships: [] as { providerId: string; role: string; accountActive: boolean }[],
  deps: { fake: true } as null | object,
  start: vi.fn(),
  refresh: vi.fn(),
  register: vi.fn(),
  sellers: {} as null | object,
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ get config() { return state.config; } }));
vi.mock("@/lib/host/accounts", () => ({
  readExperienceHostSession: async () => state.session,
  nowUtc: () => "2026-11-28T00:00:00.000Z",
  readSmallForm: async (request: Request, fields: readonly string[], required: readonly string[]) => {
    const values = new URLSearchParams(await request.text());
    if (required.some((name) => !values.has(name)) || [...values.keys()].some((name) => !fields.includes(name))) return { ok: false, status: 400 };
    return { ok: true, values };
  },
}));
vi.mock("@/lib/host/niho-identity-server", () => ({ reauthenticationHref: async () => "/host/auth/niho-reauth?next=back" }));
vi.mock("@/lib/host/session", () => ({ ACCOUNT_SESSION_COOKIE: "sid", recentlyAuthenticated: () => state.recent }));
vi.mock("@/lib/host/server", () => ({
  hostNotFound: () => Response.json({ error: "not_found" }, { status: 404 }),
  noStoreJson: (body: unknown, status = 200) => Response.json(body, { status }),
  seeOther: (location: string) => new Response(null, { status: 303, headers: { location } }),
  siteOrigin: () => "https://experience.example",
}));
vi.mock("@/lib/host/providers", () => ({ nihoIdOrNull: (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : null }));
vi.mock("./store-server", () => ({
  directSellers: () => state.sellers,
  experiencePublicationRepository: () => ({ listHostAccountMemberships: async (_id: string, providerId?: string) => state.memberships.filter((m) => providerId === undefined || m.providerId === providerId) }),
}));
vi.mock("./host-connect-onboarding-server", () => ({ payoutOnboardingDeps: () => state.deps }));
vi.mock("./host-direct-account", () => ({
  startDirectOnboarding: (...args: unknown[]) => state.start(...args),
  refreshDirectOnboardingLink: (...args: unknown[]) => state.refresh(...args),
  registerDirectSeller: (...args: unknown[]) => state.register(...args),
}));

import { getDirectOnboardingRefresh, postDirectOnboarding, postDirectSeller } from "./host-direct-account-http";

const HOST = `hst_${"a".repeat(32)}`;
const STRIPE = "https://connect.stripe.com/setup/e/acct_x/abc";
const BASE = { hostConsoleEnabled: true, hostAccountsEnabled: true, hostStandardOnboardingEnabled: true, experiencePayoutAccountConsentVersion: "consent-v1" };

function post(query = "?providerId=provider-a", options: { sameOrigin?: boolean; path?: string; body?: string } = {}): NextRequest {
  return new NextRequest(`https://experience.example/host/api/direct-account/${options.path ?? "onboarding"}${query}`, {
    method: "POST",
    headers: {
      origin: options.sameOrigin === false ? "https://attacker.example" : "https://experience.example",
      "sec-fetch-site": options.sameOrigin === false ? "cross-site" : "same-origin",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: options.body ?? "",
  });
}
const seller = (body = "accountLast4=0001&consentVersion=consent-v1&accepted=yes", query = "?providerId=provider-a") => post(query, { path: "seller", body });
const get = (query = "?providerId=provider-a") => new NextRequest(`https://experience.example/host/api/direct-account/onboarding/refresh${query}`);

beforeEach(() => {
  state.config = { ...BASE };
  state.session = { hostAccountId: HOST, authenticatedAtUtc: new Date().toISOString() };
  state.recent = true;
  state.memberships = [{ providerId: "provider-a", role: "OWNER", accountActive: true }];
  state.deps = { fake: true };
  state.sellers = { fakeSellers: true };
  state.start.mockReset().mockResolvedValue({ kind: "link", url: STRIPE });
  state.refresh.mockReset().mockResolvedValue({ kind: "link", url: STRIPE });
  state.register.mockReset().mockResolvedValue({ kind: "registered" });
});

describe("POST /host/api/direct-account/onboarding", () => {
  it("is 404 while the flag is off (all three routes, and nothing is called), even with the payout flag on", async () => {
    state.config = { ...BASE, hostStandardOnboardingEnabled: false, hostConnectOnboardingEnabled: true } as typeof state.config;
    expect((await postDirectOnboarding(post())).status).toBe(404);
    expect((await getDirectOnboardingRefresh(get())).status).toBe(404);
    expect((await postDirectSeller(seller())).status).toBe(404);
    expect(state.start).not.toHaveBeenCalled();
    expect(state.register).not.toHaveBeenCalled();
  });

  it("sends the OWNER to Stripe with a no-store, no-referrer 303", async () => {
    const response = await postDirectOnboarding(post());
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(STRIPE);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(state.start).toHaveBeenCalledWith({ providerId: "provider-a", nihoUserId: HOST }, state.deps);
  });

  it("refuses a cross-site post, an unexpected query, and a missing sign-in", async () => {
    expect((await postDirectOnboarding(post("?providerId=provider-a", { sameOrigin: false }))).status).toBe(403);
    expect((await postDirectOnboarding(post("?providerId=provider-a&x=1"))).status).toBe(400);
    state.session = null;
    const response = await postDirectOnboarding(post());
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain("/host/auth/sign-in");
    expect(state.start).not.toHaveBeenCalled();
  });

  it("sends a sign-in older than 30 minutes to sign in again, before anything is created", async () => {
    state.recent = false;
    const response = await postDirectOnboarding(post());
    expect(response.headers.get("location")).toBe("/host/auth/niho-reauth?next=back");
    expect(state.start).not.toHaveBeenCalled();
  });

  it("refuses another host's id, a COHOST, and an account that owns several hosts without naming one", async () => {
    expect((await postDirectOnboarding(post("?providerId=provider-other"))).status).toBe(403);
    state.memberships = [{ providerId: "provider-a", role: "COHOST", accountActive: true }];
    expect((await postDirectOnboarding(post())).status).toBe(403);
    state.memberships = [{ providerId: "provider-a", role: "OWNER", accountActive: true }, { providerId: "provider-b", role: "OWNER", accountActive: true }];
    expect((await postDirectOnboarding(post(""))).status).toBe(409);
    expect(state.start).not.toHaveBeenCalled();
  });

  it("goes back to 受取口座 with what happened when the flow could not finish", async () => {
    state.start.mockResolvedValue({ kind: "failed", outcome: "directSeller" });
    const response = await postDirectOnboarding(post());
    expect(response.headers.get("location")).toBe("/host/settings?providerId=provider-a&payout=directSeller#settings-payout");
  });
});

describe("GET /host/api/direct-account/onboarding/refresh", () => {
  it("makes a new link for a recently signed-in OWNER", async () => {
    const response = await getDirectOnboardingRefresh(get());
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(STRIPE);
    expect(state.refresh).toHaveBeenCalledWith("provider-a", state.deps);
  });

  it("asks to sign in again when old, and refuses a stranger and a COHOST", async () => {
    state.recent = false;
    expect((await getDirectOnboardingRefresh(get())).headers.get("location")).toBe("/host/auth/niho-reauth?next=back");
    state.recent = true;
    expect((await getDirectOnboardingRefresh(get("?providerId=provider-other"))).status).toBe(403);
    state.memberships = [{ providerId: "provider-a", role: "COHOST", accountActive: true }];
    expect((await getDirectOnboardingRefresh(get())).status).toBe(403);
    expect(state.refresh).not.toHaveBeenCalled();
  });
});

describe("POST /host/api/direct-account/seller", () => {
  it("registers the seller for the OWNER and goes back to 受取口座", async () => {
    const response = await postDirectSeller(seller());
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/host/settings?providerId=provider-a&payout=directRegistered#settings-payout");
    expect(state.register).toHaveBeenCalledTimes(1);
    const [actor, , input] = state.register.mock.calls[0]!;
    expect(actor).toEqual({ providerId: "provider-a", nihoUserId: HOST });
    expect(input).toEqual({ accountLast4: "0001", consentVersion: "consent-v1" });
  });

  it("refuses a cross-site post, a missing field, a sign-in older than 30 minutes and a non-OWNER", async () => {
    expect((await postDirectSeller(post("?providerId=provider-a", { path: "seller", body: "accountLast4=0001&consentVersion=consent-v1&accepted=yes", sameOrigin: false }))).status).toBe(403);
    expect((await postDirectSeller(seller("consentVersion=consent-v1&accepted=yes"))).status).toBe(400);
    state.recent = false;
    expect((await postDirectSeller(seller())).headers.get("location")).toBe("/host/auth/niho-reauth?next=back");
    state.recent = true;
    state.memberships = [{ providerId: "provider-a", role: "COHOST", accountActive: true }];
    expect((await postDirectSeller(seller())).status).toBe(403);
    expect(state.register).not.toHaveBeenCalled();
  });

  it("needs the checkbox and the configured consent version", async () => {
    expect((await postDirectSeller(seller("accountLast4=0001&consentVersion=consent-v1"))).headers.get("location")).toContain("payout=directUnchecked");
    expect((await postDirectSeller(seller("accountLast4=0001&consentVersion=old&accepted=yes"))).headers.get("location")).toContain("payout=directChanged");
    state.config = { ...BASE, experiencePayoutAccountConsentVersion: "" } as typeof state.config;
    expect((await postDirectSeller(seller())).headers.get("location")).toContain("payout=directChanged");
    expect(state.register).not.toHaveBeenCalled();
  });

  it("says why when the account is not ready or the disclosure is missing", async () => {
    state.register.mockResolvedValue({ kind: "failed", outcome: "directNotReady" });
    expect((await postDirectSeller(seller())).headers.get("location")).toContain("payout=directNotReady");
    state.register.mockResolvedValue({ kind: "failed", outcome: "directDisclosure" });
    expect((await postDirectSeller(seller())).headers.get("location")).toContain("payout=directDisclosure");
  });

  it("is 503 without the store", async () => {
    state.sellers = null;
    expect((await postDirectSeller(seller())).status).toBe(503);
  });
});
