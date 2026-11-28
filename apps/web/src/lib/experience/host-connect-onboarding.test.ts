import { describe, expect, it, vi } from "vitest";
import { StoreAccessDeniedError, StoreConflictError, type ConnectAccountRecord, type ConnectAccountSnapshot } from "@niho-experience/experience-store";
import { applyAccountUpdated, loadPayoutScreenState, refreshPayoutOnboardingLink, startPayoutOnboarding, type PayoutOnboardingDeps, type PayoutOnboardingStore } from "./host-connect-onboarding";

/* 受取口座の登録 (#710): the flow with a fake store and a stub Stripe. No real Stripe, synthetic data only. */
const ACTOR = { providerId: "provider-synthetic", nihoUserId: `hst_${"a".repeat(32)}` };
const NOW = new Date("2026-11-28T03:00:00.000Z");
const ACCOUNT = "acct_SamplePayout0001";
const LINK = "https://connect.stripe.com/setup/e/acct_SamplePayout0001/abc";

function stripeAccount(over: Record<string, unknown> = {}, id = ACCOUNT): Record<string, unknown> {
  return {
    id, country: "JP", default_currency: "jpy", details_submitted: true, payouts_enabled: true, capabilities: { transfers: "active" },
    controller: { type: "application", losses: { payments: "application" }, fees: { payer: "application" }, requirement_collection: "stripe", stripe_dashboard: { type: "express" } },
    metadata: { provider_id: ACTOR.providerId, creation_id: "x", source: "niho-experience", purpose: "payout" },
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

function deps(store: PayoutOnboardingStore, stripe: Record<string, unknown>, now = NOW): PayoutOnboardingDeps {
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

describe("startPayoutOnboarding", () => {
  it("reserves the row first, creates the account with the row's idempotency key, writes its ID once and gives the link", async () => {
    const fake = fakeStore();
    const stripe = okStripe();
    const result = await startPayoutOnboarding(ACTOR, deps(fake.store, stripe));
    expect(result).toEqual({ kind: "link", url: LINK });
    expect(stripe.accounts.create).toHaveBeenCalledTimes(1);
    const [params, options] = stripe.accounts.create.mock.calls[0] as unknown as [Record<string, unknown>, Record<string, unknown>];
    expect(options).toEqual({ idempotencyKey: "experience-payout-account:123e4567-e89b-42d3-a456-426614174000" });
    expect(params).toMatchObject({ country: "JP", capabilities: { transfers: { requested: true } }, metadata: { creation_id: "123e4567-e89b-42d3-a456-426614174000", provider_id: ACTOR.providerId } });
    expect("business_type" in params).toBe(false);
    expect(fake.row?.stripeAccountRef).toBe(ACCOUNT);
    expect(stripe.accountLinks.create).toHaveBeenCalledWith({
      account: ACCOUNT, type: "account_onboarding",
      return_url: `https://experience.example/host/settings?providerId=${ACTOR.providerId}&connect=return`,
      refresh_url: `https://experience.example/host/api/payout-account/onboarding/refresh?providerId=${ACTOR.providerId}`,
    });
  });

  it("two presses leave one account: the second reuses the row and its account", async () => {
    const fake = fakeStore();
    const stripe = okStripe();
    await startPayoutOnboarding(ACTOR, deps(fake.store, stripe));
    await startPayoutOnboarding(ACTOR, { ...deps(fake.store, stripe), newId: () => "123e4567-e89b-42d3-a456-426614174999" });
    expect(stripe.accounts.create).toHaveBeenCalledTimes(1);
    expect(fake.row?.id).toBe("123e4567-e89b-42d3-a456-426614174000");
    expect(stripe.accountLinks.create).toHaveBeenCalledTimes(2);
  });

  it("resumes an unfinished creation with the stored parameters and key (a crash before the ID was written)", async () => {
    const { payoutAccountCreationParams } = await import("@niho-experience/experience-payments");
    const id = "123e4567-e89b-42d3-a456-426614174111";
    const row: ConnectAccountRecord = { id, providerId: ACTOR.providerId, purpose: "PAYOUT", stripeAccountRef: null, creationParams: payoutAccountCreationParams({ providerId: ACTOR.providerId, creationId: id }) as never, createdByHostAccountId: ACTOR.nihoUserId, createdAtUtc: new Date(NOW.getTime() - 22 * 3600_000).toISOString(), retiredAtUtc: null };
    const fake = fakeStore(row);
    const stripe = okStripe();
    stripe.accounts.create.mockImplementation(async (params: { metadata: Record<string, string> }) => stripeAccount({ metadata: params.metadata }));
    expect(await startPayoutOnboarding(ACTOR, deps(fake.store, stripe))).toEqual({ kind: "link", url: LINK });
    expect((stripe.accounts.create.mock.calls[0] as unknown[])[1]).toEqual({ idempotencyKey: `experience-payout-account:${id}` });
    expect(stripe.accounts.list).not.toHaveBeenCalled();
  });

  it("after 23 hours it looks the account up by its creation id and never creates another", async () => {
    const id = "123e4567-e89b-42d3-a456-426614174222";
    const old: ConnectAccountRecord = { id, providerId: ACTOR.providerId, purpose: "PAYOUT", stripeAccountRef: null, creationParams: {}, createdByHostAccountId: ACTOR.nihoUserId, createdAtUtc: new Date(NOW.getTime() - 24 * 3600_000).toISOString(), retiredAtUtc: null };
    const found = fakeStore(old);
    const stripe = okStripe();
    stripe.accounts.list.mockResolvedValue({ data: [stripeAccount({ metadata: { provider_id: ACTOR.providerId, creation_id: id, source: "niho-experience", purpose: "payout" } })], has_more: false });
    expect(await startPayoutOnboarding(ACTOR, deps(found.store, stripe))).toEqual({ kind: "link", url: LINK });
    expect(found.row?.stripeAccountRef).toBe(ACCOUNT);
    expect(stripe.accounts.create).not.toHaveBeenCalled();

    const none = fakeStore(old);
    const empty = okStripe();
    expect(await startPayoutOnboarding(ACTOR, deps(none.store, empty))).toEqual({ kind: "failed", outcome: "connectReview" });
    expect(empty.accounts.create).not.toHaveBeenCalled();
    expect(empty.accountLinks.create).not.toHaveBeenCalled();
  });

  it("refuses a provider that has a Direct charge seller, and a person who is not its OWNER, before any Stripe call", async () => {
    const seller = fakeStore(null, { seller: true });
    const stripe = okStripe();
    expect(await startPayoutOnboarding(ACTOR, deps(seller.store, stripe))).toEqual({ kind: "failed", outcome: "connectSeller" });
    const other = fakeStore();
    expect(await startPayoutOnboarding({ ...ACTOR, nihoUserId: `hst_${"b".repeat(32)}` }, deps(other.store, stripe))).toEqual({ kind: "failed", outcome: "connectForbidden" });
    expect(stripe.accounts.create).not.toHaveBeenCalled();
  });

  it("answers unavailable (nothing logged but the class) when Stripe fails", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const stripe = okStripe();
    stripe.accounts.create.mockRejectedValue(new Error("sk_test_secret in message"));
    expect(await startPayoutOnboarding(ACTOR, deps(fakeStore().store, stripe))).toEqual({ kind: "failed", outcome: "connectUnavailable" });
    expect(JSON.stringify(log.mock.calls)).not.toContain("sk_test_secret");
    log.mockRestore();
  });
});

describe("refreshPayoutOnboardingLink", () => {
  it("makes a new link for the existing account, and says not started without one", async () => {
    const fake = fakeStore();
    const stripe = okStripe();
    expect(await refreshPayoutOnboardingLink(ACTOR.providerId, deps(fake.store, stripe))).toEqual({ kind: "failed", outcome: "connectNotStarted" });
    await startPayoutOnboarding(ACTOR, deps(fake.store, stripe));
    expect(await refreshPayoutOnboardingLink(ACTOR.providerId, deps(fake.store, stripe))).toEqual({ kind: "link", url: LINK });
    expect(stripe.accounts.create).toHaveBeenCalledTimes(1);
  });
});

describe("loadPayoutScreenState", () => {
  it("is NOT_STARTED with no row, and seller for a provider with a Direct charge seller", async () => {
    expect(await loadPayoutScreenState(ACTOR.providerId, deps(fakeStore().store, okStripe()))).toEqual({ state: "NOT_STARTED" });
    expect(await loadPayoutScreenState(ACTOR.providerId, deps(fakeStore(null, { seller: true }).store, okStripe()))).toBe("seller");
  });

  it.each([
    [{ details_submitted: false }, "IN_PROGRESS"],
    [{ payouts_enabled: false }, "VERIFYING"],
    [{ requirements: { currently_due: ["individual.dob.day"], past_due: [], pending_verification: [], disabled_reason: null } }, "ACTION_REQUIRED"],
    [{ requirements: { currently_due: [], past_due: [], pending_verification: [], disabled_reason: "rejected.fraud" }, payouts_enabled: false }, "REJECTED"],
    [{}, "READY"],
  ])("reads Stripe every time and keeps what it said (%j -> %s)", async (over, expected) => {
    const fake = fakeStore();
    const stripe = okStripe();
    await startPayoutOnboarding(ACTOR, deps(fake.store, stripe));
    stripe.accounts.retrieve.mockResolvedValue(stripeAccount(over));
    expect(await loadPayoutScreenState(ACTOR.providerId, deps(fake.store, stripe))).toEqual({ state: expected });
    expect(fake.saved.at(-1)).toMatchObject({ input: { state: expected, payoutReady: expected === "READY" }, opts: { notify: false } });
  });

  it("falls back to the last kept state when Stripe cannot be read, and to unknown with none", async () => {
    const fake = fakeStore();
    const stripe = okStripe();
    await startPayoutOnboarding(ACTOR, deps(fake.store, stripe));
    stripe.accounts.retrieve.mockRejectedValue(new Error("down"));
    expect(await loadPayoutScreenState(ACTOR.providerId, deps(fake.store, stripe))).toEqual({ state: "unknown" });
    stripe.accounts.retrieve.mockResolvedValue(stripeAccount({ details_submitted: false }));
    await loadPayoutScreenState(ACTOR.providerId, deps(fake.store, stripe));
    stripe.accounts.retrieve.mockRejectedValue(new Error("down"));
    expect(await loadPayoutScreenState(ACTOR.providerId, deps(fake.store, stripe))).toEqual({ state: "IN_PROGRESS" });
  });

  it("shows unknown, not the kept state, when Stripe no longer shows the account", async () => {
    const fake = fakeStore();
    const stripe = okStripe();
    await startPayoutOnboarding(ACTOR, deps(fake.store, stripe));
    await loadPayoutScreenState(ACTOR.providerId, deps(fake.store, stripe));
    stripe.accounts.retrieve.mockRejectedValue(Object.assign(new Error("gone"), { type: "StripeInvalidRequestError", code: "resource_missing" }));
    expect(await loadPayoutScreenState(ACTOR.providerId, deps(fake.store, stripe))).toEqual({ state: "unknown" });
  });

  it("is never READY for an account that is not this provider's Express JPY payout account", async () => {
    const fake = fakeStore();
    const stripe = okStripe();
    await startPayoutOnboarding(ACTOR, deps(fake.store, stripe));
    stripe.accounts.retrieve.mockResolvedValue(stripeAccount({ metadata: { provider_id: "provider-other", source: "niho-experience", purpose: "payout" } }));
    expect(await loadPayoutScreenState(ACTOR.providerId, deps(fake.store, stripe))).toEqual({ state: "REJECTED" });
  });
});

describe("applyAccountUpdated", () => {
  it("ignores an account that is not ours or is retired (nothing read from Stripe)", async () => {
    const fake = fakeStore();
    const stripe = okStripe();
    expect(await applyAccountUpdated("acct_SomeoneElse0001", deps(fake.store, stripe))).toBe("ignored");
    await startPayoutOnboarding(ACTOR, deps(fake.store, stripe));
    stripe.accounts.retrieve.mockClear();
    (fake.store.findByAccountRef as unknown as { mockResolvedValueOnce(value: unknown): void }).mockResolvedValueOnce({ account: { ...fake.row!, retiredAtUtc: NOW.toISOString() }, snapshot: null });
    expect(await applyAccountUpdated(ACCOUNT, deps(fake.store, stripe))).toBe("ignored");
    expect(stripe.accounts.retrieve).not.toHaveBeenCalled();
  });

  it("reads our account again (not the event's payload) and keeps it, asking the store to mail when more is needed", async () => {
    const fake = fakeStore();
    const stripe = okStripe();
    await startPayoutOnboarding(ACTOR, deps(fake.store, stripe));
    stripe.accounts.retrieve.mockResolvedValue(stripeAccount({ requirements: { currently_due: ["external_account"], past_due: [], pending_verification: [], disabled_reason: null } }));
    expect(await applyAccountUpdated(ACCOUNT, deps(fake.store, stripe))).toBe("updated");
    expect(stripe.accounts.retrieve).toHaveBeenCalledWith(ACCOUNT);
    expect(fake.saved.at(-1)).toMatchObject({ input: { state: "ACTION_REQUIRED" }, opts: { notify: true } });
  });
});
