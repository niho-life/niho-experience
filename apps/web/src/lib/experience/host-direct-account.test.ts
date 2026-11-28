import { describe, expect, it, vi } from "vitest";
import { StoreAccessDeniedError, StoreConflictError, type ConnectAccountRecord, type ConnectAccountSnapshot } from "@niho-experience/experience-store";
import { applyAccountUpdated, startPayoutOnboarding, type PayoutOnboardingDeps, type PayoutOnboardingStore } from "./host-connect-onboarding";
import { loadDirectScreenState, refreshDirectOnboardingLink, registerDirectSeller, startDirectOnboarding, type DirectAccountDeps } from "./host-direct-account";

/* 自分の Stripe アカウント (#726, 3c-1): the flow with a fake store and a stub Stripe. No real Stripe, synthetic data only. */
const ACTOR = { providerId: "provider-synthetic", nihoUserId: `hst_${"a".repeat(32)}` };
const NOW = new Date("2026-11-28T03:00:00.000Z");
const ACCOUNT = "acct_SampleDirect0001";
const LINK = "https://connect.stripe.com/setup/e/acct_SampleDirect0001/abc";

function stripeAccount(over: Record<string, unknown> = {}, id = ACCOUNT): Record<string, unknown> {
  return {
    id, country: "JP", default_currency: "jpy", details_submitted: true, payouts_enabled: true, charges_enabled: true, capabilities: { card_payments: "active", transfers: "active" },
    controller: { type: "application", losses: { payments: "stripe" }, fees: { payer: "account" }, requirement_collection: "stripe", stripe_dashboard: { type: "full" } },
    metadata: { provider_id: ACTOR.providerId, creation_id: "x", source: "niho-experience", purpose: "direct" },
    requirements: { currently_due: [], past_due: [], pending_verification: [], disabled_reason: null },
    ...over,
  };
}

/** An in-memory store with the semantics that matter: one valid row per provider, the account ID once. */
function fakeStore(initial: ConnectAccountRecord | null = null, options: { seller?: boolean } = {}) {
  let row = initial;
  let snapshot: ConnectAccountSnapshot | null = null;
  const saved: unknown[] = [];
  const store: PayoutOnboardingStore = {
    reserve: vi.fn(async (actor, input) => {
      if (options.seller) throw new StoreConflictError("SELLER_EXISTS");
      if (actor.nihoUserId !== ACTOR.nihoUserId) throw new StoreAccessDeniedError();
      if (row) return { account: row, created: false };
      row = { id: input.id!, providerId: actor.providerId, purpose: input.purpose ?? "PAYOUT", stripeAccountRef: null, creationParams: input.creationParams, createdByHostAccountId: actor.nihoUserId, createdAtUtc: NOW.toISOString(), retiredAtUtc: null };
      return { account: row, created: true };
    }),
    recordAccountRef: vi.fn(async (_actor, id, ref) => {
      if (!row || row.id !== id) throw new StoreConflictError("retired");
      if (row.stripeAccountRef && row.stripeAccountRef !== ref) throw new StoreConflictError("set");
      row = { ...row, stripeAccountRef: ref };
      return row;
    }),
    currentPayout: vi.fn(async () => (row && row.purpose === "PAYOUT" ? { account: row, snapshot } : null)),
    currentDirect: vi.fn(async () => (row && row.purpose === "DIRECT" ? { account: row, snapshot } : null)),
    agentSalesHistoryExists: vi.fn(async () => false),
    payoutBlock: vi.fn(async () => null),
    findByAccountRef: vi.fn(async (ref: string) => (row?.stripeAccountRef === ref ? { account: row, snapshot } : null)),
    saveSnapshot: vi.fn(async (_id, input, opts) => { saved.push({ input, opts }); snapshot = input; return { saved: true, mailQueued: false }; }),
    sellerExists: vi.fn(async () => options.seller === true),
  };
  return { store, saved, get row() { return row; } };
}

function deps(store: PayoutOnboardingStore, stripe: Record<string, unknown>, now = NOW): DirectAccountDeps & PayoutOnboardingDeps {
  return {
    accounts: store, platformStripeKey: "sk_test_synthetic", siteOrigin: "https://experience.example", now: () => now,
    newId: () => "123e4567-e89b-42d3-a456-426614174000",
    stripe: stripe as never,
  };
}

const okStripe = () => ({
  accounts: {
    create: vi.fn(async (params: { metadata: Record<string, string> }) => stripeAccount({ metadata: params.metadata })),
    retrieve: vi.fn(async () => stripeAccount()),
    list: vi.fn(async (): Promise<{ data: unknown[]; has_more: boolean }> => ({ data: [], has_more: false })),
  },
  accountLinks: { create: vi.fn(async () => ({ url: LINK })) },
});

describe("startDirectOnboarding", () => {
  it("reserves a DIRECT row, creates a full-dashboard account with the row's id, records its ID and gives the link", async () => {
    const fake = fakeStore();
    const stripe = okStripe();
    expect(await startDirectOnboarding(ACTOR, deps(fake.store, stripe))).toEqual({ kind: "link", url: LINK });
    expect(fake.store.reserve).toHaveBeenCalledWith(ACTOR, expect.objectContaining({ purpose: "DIRECT" }));
    expect(fake.row).toMatchObject({ purpose: "DIRECT", stripeAccountRef: ACCOUNT });
    const [params, options] = stripe.accounts.create.mock.calls[0] as unknown as [Record<string, unknown>, { idempotencyKey: string }];
    expect(params).toMatchObject({ country: "JP", controller: { stripe_dashboard: { type: "full" }, losses: { payments: "stripe" }, fees: { payer: "account" } }, capabilities: { card_payments: { requested: true }, transfers: { requested: true } } });
    expect(options.idempotencyKey).toBe("experience-direct-account:123e4567-e89b-42d3-a456-426614174000");
    const link = stripe.accountLinks.create.mock.calls[0] as unknown as [Record<string, string>];
    expect(link[0]).toMatchObject({ type: "account_onboarding", return_url: "https://experience.example/host/settings?providerId=provider-synthetic&connect=return", refresh_url: "https://experience.example/host/api/direct-account/onboarding/refresh?providerId=provider-synthetic" });
  });

  it("continues an existing row with a new link and no second account", async () => {
    const fake = fakeStore();
    const stripe = okStripe();
    await startDirectOnboarding(ACTOR, deps(fake.store, stripe));
    await startDirectOnboarding(ACTOR, deps(fake.store, stripe));
    expect(stripe.accounts.create).toHaveBeenCalledTimes(1);
    expect(stripe.accountLinks.create).toHaveBeenCalledTimes(2);
  });

  it("finds an old unfinished creation by its metadata (purpose direct) and never creates another", async () => {
    const old: ConnectAccountRecord = { id: "123e4567-e89b-42d3-a456-426614174000", providerId: ACTOR.providerId, purpose: "DIRECT", stripeAccountRef: null, creationParams: {}, createdByHostAccountId: ACTOR.nihoUserId, createdAtUtc: new Date(NOW.getTime() - 25 * 3_600_000).toISOString(), retiredAtUtc: null };
    const stripe = okStripe();
    expect(await startDirectOnboarding(ACTOR, deps(fakeStore(old).store, stripe))).toEqual({ kind: "failed", outcome: "directReview" });
    stripe.accounts.list.mockResolvedValue({ data: [stripeAccount({ metadata: { provider_id: ACTOR.providerId, creation_id: old.id, source: "niho-experience", purpose: "payout" } })], has_more: false });
    expect(await startDirectOnboarding(ACTOR, deps(fakeStore(old).store, stripe))).toEqual({ kind: "failed", outcome: "directReview" });
    stripe.accounts.list.mockResolvedValue({ data: [stripeAccount({ metadata: { provider_id: ACTOR.providerId, creation_id: old.id, source: "niho-experience", purpose: "direct" } })], has_more: false });
    expect(await startDirectOnboarding(ACTOR, deps(fakeStore(old).store, stripe))).toEqual({ kind: "link", url: LINK });
    expect(stripe.accounts.create).not.toHaveBeenCalled();
  });

  it("tells a seller, a stranger and a failure apart", async () => {
    expect(await startDirectOnboarding(ACTOR, deps(fakeStore(null, { seller: true }).store, okStripe()))).toEqual({ kind: "failed", outcome: "directSeller" });
    expect(await startDirectOnboarding({ ...ACTOR, nihoUserId: `hst_${"b".repeat(32)}` }, deps(fakeStore().store, okStripe()))).toEqual({ kind: "failed", outcome: "directForbidden" });
    const broken = okStripe();
    broken.accounts.create.mockRejectedValue(new Error("down"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await startDirectOnboarding(ACTOR, deps(fakeStore().store, broken))).toEqual({ kind: "failed", outcome: "directUnavailable" });
  });
});

describe("refresh, screen state and the webhook", () => {
  it("makes a new link only when the account exists", async () => {
    const fake = fakeStore();
    expect(await refreshDirectOnboardingLink(ACTOR.providerId, deps(fake.store, okStripe()))).toEqual({ kind: "failed", outcome: "directNotStarted" });
    await startDirectOnboarding(ACTOR, deps(fake.store, okStripe()));
    expect(await refreshDirectOnboardingLink(ACTOR.providerId, deps(fake.store, okStripe()))).toEqual({ kind: "link", url: LINK });
  });

  it("reads Stripe on every load and keeps charges_enabled; falls back to the kept state when Stripe cannot be read", async () => {
    const fake = fakeStore();
    const stripe = okStripe();
    expect(await loadDirectScreenState(ACTOR.providerId, deps(fake.store, stripe))).toEqual({ state: "NOT_STARTED", accountRef: null });
    await startDirectOnboarding(ACTOR, deps(fake.store, stripe));
    expect(await loadDirectScreenState(ACTOR.providerId, deps(fake.store, stripe))).toEqual({ state: "READY", accountRef: ACCOUNT });
    expect(fake.saved.at(-1)).toMatchObject({ input: { state: "READY", payoutReady: true, chargesEnabled: true }, opts: { notify: false } });
    stripe.accounts.retrieve.mockRejectedValue(new Error("down"));
    expect(await loadDirectScreenState(ACTOR.providerId, deps(fake.store, stripe))).toEqual({ state: "READY", accountRef: ACCOUNT });
  });

  it("applyAccountUpdated reads a DIRECT account again and keeps it with no email (notify off)", async () => {
    const fake = fakeStore();
    const stripe = okStripe();
    await startDirectOnboarding(ACTOR, deps(fake.store, stripe));
    stripe.accounts.retrieve.mockResolvedValue(stripeAccount({ requirements: { currently_due: ["external_account"], past_due: [], pending_verification: [], disabled_reason: null } }));
    expect(await applyAccountUpdated(ACCOUNT, deps(fake.store, stripe))).toBe("updated");
    expect(fake.saved.at(-1)).toMatchObject({ input: { state: "ACTION_REQUIRED" }, opts: { notify: false } });
  });

  it("applyAccountUpdated still mails for a payout account", async () => {
    const fake = fakeStore();
    const stripe = okStripe();
    await startPayoutOnboarding(ACTOR, deps(fake.store, stripe));
    stripe.accounts.retrieve.mockResolvedValue({ ...stripeAccount({ requirements: { currently_due: ["external_account"], past_due: [], pending_verification: [], disabled_reason: null } }), controller: { losses: { payments: "application" }, fees: { payer: "application" }, requirement_collection: "stripe", stripe_dashboard: { type: "express" } }, metadata: { provider_id: ACTOR.providerId, source: "niho-experience", purpose: "payout" } });
    await applyAccountUpdated(ACCOUNT, deps(fake.store, stripe));
    expect(fake.saved.at(-1)).toMatchObject({ opts: { notify: true } });
  });
});

describe("registerDirectSeller", () => {
  const input = { accountLast4: "0001", consentVersion: "consent-v1" };
  async function ready() {
    const fake = fakeStore();
    const stripe = okStripe();
    await startDirectOnboarding(ACTOR, deps(fake.store, stripe));
    const register = vi.fn(async () => ({}));
    return { fake, stripe, register, deps: { ...deps(fake.store, stripe), sellers: { register } as never } };
  }

  it("reads Stripe just before, then registers with that read's time", async () => {
    const { stripe, register, deps: d } = await ready();
    expect(await registerDirectSeller(ACTOR, d, input)).toEqual({ kind: "registered" });
    expect(stripe.accounts.retrieve).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith(ACTOR, { stripeConnectAccountRef: ACCOUNT, consentVersion: "consent-v1", nowUtc: NOW.toISOString() });
  });

  it("does not register when Stripe is not READY, the account shown differs, or there is no account", async () => {
    const { stripe, register, deps: d } = await ready();
    expect(await registerDirectSeller(ACTOR, d, { ...input, accountLast4: "9999" })).toEqual({ kind: "failed", outcome: "directChanged" });
    stripe.accounts.retrieve.mockResolvedValue(stripeAccount({ charges_enabled: false }));
    expect(await registerDirectSeller(ACTOR, d, input)).toEqual({ kind: "failed", outcome: "directNotReady" });
    expect(await registerDirectSeller(ACTOR, { ...deps(fakeStore().store, okStripe()), sellers: { register } as never }, input)).toEqual({ kind: "failed", outcome: "directNotStarted" });
    expect(register).not.toHaveBeenCalled();
  });

  it("names why the store refused", async () => {
    const { register, deps: d } = await ready();
    for (const [message, outcome] of [["SELLER_EXISTS", "directSeller"], ["SELLER_DISCLOSURE_REQUIRED", "directDisclosure"], ["DIRECT_ACCOUNT_NOT_READY", "directNotReady"], ["PUBLIC_PROFILE_MISSING", "directProfile"], ["SOMETHING_ELSE", "directChanged"]] as const) {
      register.mockRejectedValueOnce(new StoreConflictError(message));
      expect(await registerDirectSeller(ACTOR, d, input)).toEqual({ kind: "failed", outcome });
    }
    register.mockRejectedValueOnce(new StoreAccessDeniedError());
    expect(await registerDirectSeller(ACTOR, d, input)).toEqual({ kind: "failed", outcome: "directForbidden" });
  });
});
