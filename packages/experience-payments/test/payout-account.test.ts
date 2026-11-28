import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Stripe from "stripe";
import {
  createAccountOnboardingLink,
  createPayoutAccount,
  findPayoutAccountByCreationId,
  payoutAccountCreationParams,
  retrievePayoutAccountStatus,
  verifyConnectWebhook,
  isAccountUpdatedEvent,
  type PayoutAccountStripeClient,
} from "../src/index.ts";

const PROVIDER = "provider-synthetic";
const CREATION = "123e4567-e89b-42d3-a456-426614174000";
const ACCOUNT = "acct_SamplePayout0001";

function account(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ACCOUNT, country: "JP", default_currency: "jpy", details_submitted: true, payouts_enabled: true, charges_enabled: false,
    capabilities: { transfers: "active" },
    controller: { type: "application", losses: { payments: "application" }, fees: { payer: "application" }, requirement_collection: "stripe", stripe_dashboard: { type: "express" } },
    metadata: { provider_id: PROVIDER, creation_id: CREATION, source: "niho-experience", purpose: "payout" },
    requirements: { currently_due: [], past_due: [], pending_verification: [], disabled_reason: null },
    ...over,
  };
}
const stubAccounts = (value: Record<string, unknown>) => ({ accounts: { retrieve: async () => value } }) as unknown as Pick<Stripe, "accounts">;
const status = (value: Record<string, unknown>) => retrievePayoutAccountStatus({ accountId: ACCOUNT, providerId: PROVIDER, stripe: stubAccounts(value) });

describe("payout account creation", () => {
  it("builds Express, Japan, transfers only, monthly payouts, with no business_type", () => {
    const params = payoutAccountCreationParams({ providerId: PROVIDER, creationId: CREATION });
    assert.deepEqual(params, {
      country: "JP",
      controller: { losses: { payments: "application" }, fees: { payer: "application" }, requirement_collection: "stripe", stripe_dashboard: { type: "express" } },
      capabilities: { transfers: { requested: true } },
      settings: { payouts: { schedule: { interval: "monthly", monthly_anchor: 1 } } },
      metadata: { provider_id: PROVIDER, creation_id: CREATION, source: "niho-experience", purpose: "payout" },
    });
    assert.equal("business_type" in params, false);
    assert.equal("card_payments" in params.capabilities, false);
  });

  it("calls accounts.create with the stored parameters and the row's id as the idempotency key", async () => {
    const calls: { params: unknown; options: unknown }[] = [];
    const stripe = { accounts: { create: async (params: unknown, options: unknown) => { calls.push({ params, options }); return account(); } }, accountLinks: {} } as unknown as PayoutAccountStripeClient;
    const creationParams = payoutAccountCreationParams({ providerId: PROVIDER, creationId: CREATION });
    assert.deepEqual(await createPayoutAccount({ creationId: CREATION, creationParams, stripe }), { accountId: ACCOUNT });
    assert.deepEqual(calls, [{ params: creationParams, options: { idempotencyKey: `experience-payout-account:${CREATION}` } }]);
  });

  it("refuses parameters that are not a payout account's, and an answer for another creation", async () => {
    const stripe = { accounts: { create: async () => account() }, accountLinks: {} } as unknown as PayoutAccountStripeClient;
    const good = payoutAccountCreationParams({ providerId: PROVIDER, creationId: CREATION });
    for (const bad of [
      { ...good, business_type: "individual" },
      { ...good, capabilities: { transfers: { requested: true }, card_payments: { requested: true } } },
      { ...good, controller: { ...good.controller, stripe_dashboard: { type: "full" } } },
      { ...good, metadata: { ...good.metadata, creation_id: "123e4567-e89b-42d3-a456-426614174999" } },
    ]) await assert.rejects(() => createPayoutAccount({ creationId: CREATION, creationParams: bad as never, stripe }), /not a payout account's/);
    const other = { accounts: { create: async () => account({ metadata: { creation_id: "x", provider_id: PROVIDER } }) }, accountLinks: {} } as unknown as PayoutAccountStripeClient;
    await assert.rejects(() => createPayoutAccount({ creationId: CREATION, creationParams: good, stripe: other }), /another account/);
  });

  it("makes an onboarding link only to Stripe's own host", async () => {
    const seen: unknown[] = [];
    const make = (url: string) => ({ accountLinks: { create: async (params: unknown) => { seen.push(params); return { url }; } }, accounts: {} }) as unknown as PayoutAccountStripeClient;
    const url = await createAccountOnboardingLink({ accountId: ACCOUNT, returnUrl: "https://example.test/host/settings", refreshUrl: "https://example.test/refresh", stripe: make("https://connect.stripe.com/setup/e/acct_x/abc") });
    assert.equal(url, "https://connect.stripe.com/setup/e/acct_x/abc");
    assert.deepEqual(seen, [{ account: ACCOUNT, type: "account_onboarding", return_url: "https://example.test/host/settings", refresh_url: "https://example.test/refresh" }]);
    await assert.rejects(() => createAccountOnboardingLink({ accountId: ACCOUNT, returnUrl: "https://example.test/a", refreshUrl: "https://example.test/b", stripe: make("https://evil.example/x") }), /unsafe/);
    await assert.rejects(() => createAccountOnboardingLink({ accountId: ACCOUNT, returnUrl: "http://example.test/a", refreshUrl: "https://example.test/b", stripe: make("https://connect.stripe.com/x") }), /https/);
  });
});

describe("payout account status", () => {
  it("is READY only when payouts and transfers are on and nothing is due", async () => {
    assert.deepEqual(await status(account()), { kind: "read", state: "READY", payoutReady: true, detailsSubmitted: true, payoutsEnabled: true, transfersActive: true, requirementsHash: (await status(account()) as { requirementsHash: string }).requirementsHash, mismatch: false });
  });

  it("maps each state", async () => {
    const state = async (over: Record<string, unknown>) => (await status(account(over)) as { state: string; payoutReady: boolean }).state;
    assert.equal(await state({ details_submitted: false }), "IN_PROGRESS");
    assert.equal(await state({ payouts_enabled: false }), "VERIFYING");
    assert.equal(await state({ requirements: { currently_due: [], past_due: [], pending_verification: ["individual.verification.document"], disabled_reason: null } }), "VERIFYING", "documents under review: not ready yet");
    assert.equal(await state({ payouts_enabled: false, requirements: { currently_due: [], past_due: [], pending_verification: ["x"], disabled_reason: "requirements.pending_verification" } }), "VERIFYING");
    assert.equal(await state({ capabilities: { transfers: "pending" } }), "VERIFYING");
    assert.equal(await state({ capabilities: { transfers: "inactive" } }), "VERIFYING");
    assert.equal(await state({ requirements: { currently_due: ["individual.dob.day"], past_due: [], pending_verification: [], disabled_reason: null } }), "ACTION_REQUIRED");
    assert.equal(await state({ requirements: { currently_due: [], past_due: ["external_account"], pending_verification: [], disabled_reason: "requirements.past_due" }, payouts_enabled: false }), "ACTION_REQUIRED");
    assert.equal(await state({ requirements: { currently_due: [], past_due: [], pending_verification: [], disabled_reason: "rejected.fraud" }, payouts_enabled: false }), "REJECTED");
    assert.equal(await state({ requirements: { currently_due: [], past_due: [], pending_verification: [], disabled_reason: "under_review" }, payouts_enabled: false }), "VERIFYING");
  });

  it("is never payout-ready when anything due, or when the account is not this provider's Express JPY account", async () => {
    const ready = async (over: Record<string, unknown>) => (await status(account(over)) as { payoutReady: boolean; mismatch: boolean });
    assert.equal((await ready({ requirements: { currently_due: ["a"], past_due: [], pending_verification: [], disabled_reason: null } })).payoutReady, false);
    for (const over of [
      { country: "US" },
      { default_currency: "usd" },
      { default_currency: null },
      { metadata: { provider_id: "provider-other", source: "niho-experience", purpose: "payout" } },
      { controller: { losses: { payments: "stripe" }, fees: { payer: "application" }, requirement_collection: "stripe", stripe_dashboard: { type: "express" } } },
      { controller: { losses: { payments: "application" }, fees: { payer: "application" }, requirement_collection: "stripe", stripe_dashboard: { type: "full" } } },
    ]) {
      const read = await ready(over);
      assert.equal(read.payoutReady, false, JSON.stringify(over));
    }
    assert.equal((await ready({ country: "US" })).mismatch, true);
    assert.equal((await status(account({ country: "US" })) as { state: string }).state, "REJECTED");
  });

  it("accepts Stripe's `application_express` fee payer: a fresh Express account is IN_PROGRESS, not REJECTED", async () => {
    const fresh = account({
      details_submitted: false, payouts_enabled: false, capabilities: { transfers: "inactive" }, default_currency: "jpy",
      controller: { type: "application", losses: { payments: "application" }, fees: { payer: "application_express" }, requirement_collection: "stripe", stripe_dashboard: { type: "express" } },
      requirements: { currently_due: ["business_type", "external_account"], past_due: [], pending_verification: [], disabled_reason: "requirements.past_due" },
    });
    const read = await status(fresh) as { state: string; mismatch: boolean; payoutReady: boolean };
    assert.deepEqual({ state: read.state, mismatch: read.mismatch, payoutReady: read.payoutReady }, { state: "IN_PROGRESS", mismatch: false, payoutReady: false });
    const done = await status(account({ controller: { type: "application", losses: { payments: "application" }, fees: { payer: "application_express" }, requirement_collection: "stripe", stripe_dashboard: { type: "express" } } })) as { state: string };
    assert.equal(done.state, "READY");
    const other = await status(account({ controller: { type: "application", losses: { payments: "application" }, fees: { payer: "account" }, requirement_collection: "stripe", stripe_dashboard: { type: "express" } } })) as { state: string };
    assert.equal(other.state, "REJECTED");
  });

  it("hashes the same need the same, and a different need differently", async () => {
    const due = (codesList: string[]) => ({ requirements: { currently_due: codesList, past_due: [], pending_verification: [], disabled_reason: null } });
    const hash = async (codesList: string[]) => (await status(account(due(codesList))) as { requirementsHash: string }).requirementsHash;
    assert.equal(await hash(["b", "a"]), await hash(["a", "b"]));
    assert.notEqual(await hash(["a"]), await hash(["a", "b"]));
  });

  it("says unreachable when Stripe does not show the account, and throws on other failures", async () => {
    const missing = { accounts: { retrieve: async () => { throw Object.assign(new Error("no"), { type: "StripeInvalidRequestError", code: "resource_missing" }); } } } as unknown as Pick<Stripe, "accounts">;
    assert.deepEqual(await retrievePayoutAccountStatus({ accountId: ACCOUNT, providerId: PROVIDER, stripe: missing }), { kind: "unreachable" });
    const down = { accounts: { retrieve: async () => { throw new Error("network"); } } } as unknown as Pick<Stripe, "accounts">;
    await assert.rejects(() => retrievePayoutAccountStatus({ accountId: ACCOUNT, providerId: PROVIDER, stripe: down }), /network/);
  });
});

describe("finding an account an unfinished creation made", () => {
  const list = (pages: Record<string, unknown>[][]) => {
    const calls: unknown[] = [];
    let index = 0;
    return { calls, stripe: { accounts: { list: async (params: unknown) => { calls.push(params); const data = pages[index++] ?? []; return { data, has_more: index < pages.length }; } } } as unknown as Pick<Stripe, "accounts"> };
  };
  const input = { creationId: CREATION, providerId: PROVIDER, rowCreatedAtUtc: "2026-11-28T00:00:00.000Z" };

  it("matches metadata.creation_id among the accounts created around the row, over pages", async () => {
    const { calls, stripe } = list([[account({ id: "acct_Other00000001", metadata: { creation_id: "no" } })], [account()]]);
    assert.equal(await findPayoutAccountByCreationId({ ...input, stripe }), ACCOUNT);
    const first = calls[0] as { created: { gte: number; lte: number } };
    const at = Date.parse(input.rowCreatedAtUtc) / 1000;
    assert.ok(first.created.gte < at && first.created.lte > at + 24 * 3600);
    assert.equal((calls[1] as { starting_after?: string }).starting_after, "acct_Other00000001");
  });

  it("is null when none, and refuses an account of another provider", async () => {
    assert.equal(await findPayoutAccountByCreationId({ ...input, stripe: list([[]]).stripe }), null);
    assert.equal(await findPayoutAccountByCreationId({ ...input, stripe: list([[account({ metadata: { creation_id: CREATION, provider_id: "provider-other", source: "niho-experience" } })]]).stripe }), null);
  });
});

describe("account.updated on the Connect webhook", () => {
  const SECRET = "whsec_synthetic_secret";
  const stripe = new Stripe("sk_test_synthetic");
  const signed = (event: Record<string, unknown>) => {
    const rawBody = Buffer.from(JSON.stringify(event));
    return { rawBody, stripeSignature: stripe.webhooks.generateTestHeaderString({ payload: rawBody.toString("utf8"), secret: SECRET }) };
  };
  const base = { id: "evt_SynthetPayout01", object: "event", api_version: "2025-01-01", created: 1_790_000_000, livemode: false, pending_webhooks: 1, request: null, data: { object: account() } };

  it("returns which account only, and nothing from the payload", () => {
    const event = verifyConnectWebhook({ ...signed({ ...base, type: "account.updated", account: ACCOUNT }), endpointSecret: SECRET, stripe: stripe as never });
    assert.ok(event && isAccountUpdatedEvent(event));
    assert.deepEqual(event, { eventId: "evt_SynthetPayout01", eventType: "account.updated", connectedAccountId: ACCOUNT });
  });

  it("needs the connected account on the event, and a good signature", () => {
    assert.throws(() => verifyConnectWebhook({ ...signed({ ...base, type: "account.updated" }), endpointSecret: SECRET, stripe: stripe as never }), /connected account/);
    assert.throws(() => verifyConnectWebhook({ ...signed({ ...base, type: "account.updated", account: ACCOUNT }), endpointSecret: "whsec_other", stripe: stripe as never }), /signature/);
  });

  it("leaves other events to verifyDirectCheckoutWebhook (an unrelated one is null)", () => {
    assert.equal(verifyConnectWebhook({ ...signed({ ...base, type: "customer.created", account: ACCOUNT }), endpointSecret: SECRET, stripe: stripe as never }), null);
  });
});
