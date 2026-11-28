import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/* 受取口座の登録の route (#710): flag, same origin, 30 minutes, OWNER of the named host. The flow itself is stubbed. */
const state = vi.hoisted(() => ({
  config: { hostConsoleEnabled: true, hostAccountsEnabled: true, hostConnectOnboardingEnabled: true },
  session: null as null | { hostAccountId: string; authenticatedAtUtc: string },
  recent: true,
  memberships: [] as { providerId: string; role: string; accountActive: boolean }[],
  deps: { fake: true } as null | object,
  start: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ get config() { return state.config; } }));
vi.mock("@/lib/host/accounts", () => ({ readExperienceHostSession: async () => state.session }));
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
  experiencePublicationRepository: () => ({ listHostAccountMemberships: async (_id: string, providerId?: string) => state.memberships.filter((m) => providerId === undefined || m.providerId === providerId) }),
}));
vi.mock("./host-connect-onboarding-server", () => ({ payoutOnboardingDeps: () => state.deps }));
vi.mock("./host-connect-onboarding", () => ({
  startPayoutOnboarding: (...args: unknown[]) => state.start(...args),
  refreshPayoutOnboardingLink: (...args: unknown[]) => state.refresh(...args),
}));

import { getPayoutOnboardingRefresh, postPayoutOnboarding } from "./host-connect-onboarding-http";

const HOST = `hst_${"a".repeat(32)}`;
const STRIPE = "https://connect.stripe.com/setup/e/acct_x/abc";

function post(query = "?providerId=provider-a", options: { sameOrigin?: boolean } = {}): NextRequest {
  return new NextRequest(`https://experience.example/host/api/payout-account/onboarding${query}`, {
    method: "POST",
    headers: {
      origin: options.sameOrigin === false ? "https://attacker.example" : "https://experience.example",
      "sec-fetch-site": options.sameOrigin === false ? "cross-site" : "same-origin",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "",
  });
}
const get = (query = "?providerId=provider-a") => new NextRequest(`https://experience.example/host/api/payout-account/onboarding/refresh${query}`);

beforeEach(() => {
  state.config = { hostConsoleEnabled: true, hostAccountsEnabled: true, hostConnectOnboardingEnabled: true };
  state.session = { hostAccountId: HOST, authenticatedAtUtc: new Date().toISOString() };
  state.recent = true;
  state.memberships = [{ providerId: "provider-a", role: "OWNER", accountActive: true }];
  state.deps = { fake: true };
  state.start.mockReset().mockResolvedValue({ kind: "link", url: STRIPE });
  state.refresh.mockReset().mockResolvedValue({ kind: "link", url: STRIPE });
});

describe("POST /host/api/payout-account/onboarding", () => {
  it("is 404 while the flag is off (and nothing is called)", async () => {
    state.config.hostConnectOnboardingEnabled = false;
    expect((await postPayoutOnboarding(post())).status).toBe(404);
    expect((await getPayoutOnboardingRefresh(get())).status).toBe(404);
    expect(state.start).not.toHaveBeenCalled();
  });

  it("sends the OWNER to Stripe with a no-store, no-referrer 303", async () => {
    const response = await postPayoutOnboarding(post());
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(STRIPE);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(state.start).toHaveBeenCalledWith({ providerId: "provider-a", nihoUserId: HOST }, state.deps);
  });

  it("refuses a cross-site post, an unexpected query, and a missing sign-in", async () => {
    expect((await postPayoutOnboarding(post("?providerId=provider-a", { sameOrigin: false }))).status).toBe(403);
    expect((await postPayoutOnboarding(post("?providerId=provider-a&x=1"))).status).toBe(400);
    state.session = null;
    const response = await postPayoutOnboarding(post());
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain("/host/auth/sign-in");
    expect(state.start).not.toHaveBeenCalled();
  });

  it("sends a sign-in older than 30 minutes to sign in again, before anything is created", async () => {
    state.recent = false;
    const response = await postPayoutOnboarding(post());
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/host/auth/niho-reauth?next=back");
    expect(state.start).not.toHaveBeenCalled();
  });

  it("refuses another host's id, a COHOST, and an account that owns several hosts without naming one", async () => {
    expect((await postPayoutOnboarding(post("?providerId=provider-other"))).status).toBe(403);
    state.memberships = [{ providerId: "provider-a", role: "COHOST", accountActive: true }];
    expect((await postPayoutOnboarding(post())).status).toBe(403);
    state.memberships = [{ providerId: "provider-a", role: "OWNER", accountActive: true }, { providerId: "provider-b", role: "OWNER", accountActive: true }];
    expect((await postPayoutOnboarding(post(""))).status).toBe(409);
    expect(state.start).not.toHaveBeenCalled();
    // Naming one of them works, for that one.
    expect((await postPayoutOnboarding(post("?providerId=provider-b"))).status).toBe(303);
    expect(state.start).toHaveBeenCalledWith({ providerId: "provider-b", nihoUserId: HOST }, state.deps);
  });

  it("goes back to 受取口座 with what happened when the flow could not finish", async () => {
    state.start.mockResolvedValue({ kind: "failed", outcome: "connectSeller" });
    const response = await postPayoutOnboarding(post());
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/host/settings?providerId=provider-a&payout=connectSeller#settings-payout");
  });
});

describe("GET /host/api/payout-account/onboarding/refresh", () => {
  it("makes a new link for a recently signed-in OWNER (no origin check: Stripe sends the host here)", async () => {
    const response = await getPayoutOnboardingRefresh(get());
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(STRIPE);
    expect(state.refresh).toHaveBeenCalledWith("provider-a", state.deps);
  });

  it("sends a sign-in older than 30 minutes to sign in again, before any link is made", async () => {
    state.recent = false;
    const response = await getPayoutOnboardingRefresh(get());
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/host/auth/niho-reauth?next=back");
    expect(state.refresh).not.toHaveBeenCalled();
  });

  it("refuses without a session, for another host's id, and for a COHOST", async () => {
    state.session = null;
    expect((await getPayoutOnboardingRefresh(get())).headers.get("location")).toContain("/host/auth/sign-in");
    state.session = { hostAccountId: HOST, authenticatedAtUtc: new Date().toISOString() };
    expect((await getPayoutOnboardingRefresh(get("?providerId=provider-other"))).status).toBe(403);
    state.memberships = [{ providerId: "provider-a", role: "COHOST", accountActive: true }];
    expect((await getPayoutOnboardingRefresh(get())).status).toBe(403);
    expect(state.refresh).not.toHaveBeenCalled();
  });
});
