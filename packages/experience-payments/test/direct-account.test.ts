import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type Stripe from "stripe";
import {
  createDirectAccount,
  directAccountCreationParams,
  directAccountFactsOf,
  findPayoutAccountByCreationId,
  retrieveDirectAccountStatus,
  type PayoutAccountStripeClient,
} from "../src/index.ts";

const PROVIDER = "provider-synthetic";
const CREATION = "123e4567-e89b-42d3-a456-426614174000";
const ACCOUNT = "acct_SampleDirect0001";

function account(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ACCOUNT, country: "JP", default_currency: "jpy", details_submitted: true, payouts_enabled: true, charges_enabled: true,
    capabilities: { card_payments: "active", transfers: "active" },
    controller: { type: "application", losses: { payments: "stripe" }, fees: { payer: "account" }, requirement_collection: "stripe", stripe_dashboard: { type: "full" } },
    metadata: { provider_id: PROVIDER, creation_id: CREATION, source: "niho-experience", purpose: "direct" },
    requirements: { currently_due: [], past_due: [], pending_verification: [], disabled_reason: null },
    ...over,
  };
}
const facts = (value: Record<string, unknown>) => directAccountFactsOf(value as unknown as Stripe.Account, PROVIDER);

describe("host's own account creation", () => {
  it("builds a full-dashboard Japan account with card payments and transfers, and no business_type or schedule", () => {
    const params = directAccountCreationParams({ providerId: PROVIDER, creationId: CREATION });
    assert.deepEqual(params, {
      country: "JP",
      controller: { losses: { payments: "stripe" }, fees: { payer: "account" }, requirement_collection: "stripe", stripe_dashboard: { type: "full" } },
      capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
      metadata: { provider_id: PROVIDER, creation_id: CREATION, source: "niho-experience", purpose: "direct" },
    });
    assert.equal("business_type" in params, false);
    assert.equal("settings" in params, false);
  });

  it("sends the stored parameters with the row's id as the idempotency key", async () => {
    const calls: { params: unknown; options: unknown }[] = [];
    const stripe = { accounts: { create: async (params: unknown, options: unknown) => { calls.push({ params, options }); return account(); } }, accountLinks: {} } as unknown as PayoutAccountStripeClient;
    const creationParams = directAccountCreationParams({ providerId: PROVIDER, creationId: CREATION });
    assert.deepEqual(await createDirectAccount({ creationId: CREATION, creationParams, stripe }), { accountId: ACCOUNT });
    assert.deepEqual(calls, [{ params: creationParams, options: { idempotencyKey: `experience-direct-account:${CREATION}` } }]);
  });

  it("refuses parameters that are not a host's own account's, and an answer for another creation", async () => {
    const stripe = { accounts: { create: async () => account() }, accountLinks: {} } as unknown as PayoutAccountStripeClient;
    const good = directAccountCreationParams({ providerId: PROVIDER, creationId: CREATION });
    for (const bad of [
      { ...good, business_type: "individual" },
      { ...good, settings: { payouts: { schedule: { interval: "monthly" } } } },
      { ...good, controller: { ...good.controller, stripe_dashboard: { type: "express" } } },
      { ...good, controller: { ...good.controller, losses: { payments: "application" } } },
      { ...good, controller: { ...good.controller, fees: { payer: "application" } } },
      { ...good, capabilities: { transfers: { requested: true } } },
      { ...good, metadata: { ...good.metadata, purpose: "payout" } },
    ]) {
      await assert.rejects(() => createDirectAccount({ creationId: CREATION, creationParams: bad as never, stripe }), /not a host's own account's/);
    }
    const other = { accounts: { create: async () => account({ metadata: { provider_id: PROVIDER, creation_id: "00000000-0000-4000-8000-000000000000", source: "niho-experience", purpose: "direct" } }) }, accountLinks: {} } as unknown as PayoutAccountStripeClient;
    await assert.rejects(() => createDirectAccount({ creationId: CREATION, creationParams: good, stripe: other }), /another account/);
  });
});

describe("host's own account state", () => {
  it("is READY only when nothing is left and every capability is active", () => {
    const ready = facts(account());
    assert.equal(ready.state, "READY");
    assert.equal(ready.payoutReady, true);
    assert.equal(ready.chargesEnabled, true);
    for (const over of [
      { charges_enabled: false },
      { payouts_enabled: false },
      { capabilities: { card_payments: "inactive", transfers: "active" } },
      { capabilities: { card_payments: "active", transfers: "pending" } },
      { requirements: { currently_due: [], past_due: [], pending_verification: ["individual.id_number"], disabled_reason: null } },
    ]) {
      const f = facts(account(over));
      assert.equal(f.state, "VERIFYING");
      assert.equal(f.payoutReady, false);
    }
  });

  it("is IN_PROGRESS before details are submitted and ACTION_REQUIRED with due requirements", () => {
    assert.equal(facts(account({ details_submitted: false })).state, "IN_PROGRESS");
    assert.equal(facts(account({ requirements: { currently_due: ["individual.dob.day"], past_due: [], pending_verification: [], disabled_reason: null } })).state, "ACTION_REQUIRED");
    assert.equal(facts(account({ requirements: { currently_due: [], past_due: ["external_account"], pending_verification: [], disabled_reason: null } })).state, "ACTION_REQUIRED");
  });

  it("is REJECTED when rejected, and for any mismatch", () => {
    assert.equal(facts(account({ requirements: { currently_due: [], past_due: [], pending_verification: [], disabled_reason: "rejected.fraud" } })).state, "REJECTED");
    for (const over of [
      { country: "US" },
      { default_currency: "usd" },
      { controller: { losses: { payments: "application" }, fees: { payer: "account" }, requirement_collection: "stripe", stripe_dashboard: { type: "full" } } },
      { controller: { losses: { payments: "stripe" }, fees: { payer: "application" }, requirement_collection: "stripe", stripe_dashboard: { type: "full" } } },
      { controller: { losses: { payments: "stripe" }, fees: { payer: "account" }, requirement_collection: "stripe", stripe_dashboard: { type: "express" } } },
      { metadata: { provider_id: "other", source: "niho-experience", purpose: "direct" } },
      { metadata: { provider_id: PROVIDER, source: "niho-experience", purpose: "payout" } },
    ]) {
      const f = facts(account(over));
      assert.equal(f.mismatch, true);
      assert.equal(f.state, "REJECTED");
      assert.equal(f.payoutReady, false);
    }
  });

  it("reads Stripe through retrieveDirectAccountStatus", async () => {
    const stripe = { accounts: { retrieve: async () => account() } } as unknown as Pick<Stripe, "accounts">;
    const read = await retrieveDirectAccountStatus({ accountId: ACCOUNT, providerId: PROVIDER, stripe });
    assert.equal(read.kind, "read");
    await assert.rejects(() => retrieveDirectAccountStatus({ accountId: "acct_Other0000001", providerId: PROVIDER, stripe }), /another account/);
  });
});

describe("finding an unfinished creation by purpose", () => {
  it("matches metadata.purpose", async () => {
    const list = async () => ({ data: [account(), account({ id: "acct_SamplePayout0001", metadata: { provider_id: PROVIDER, creation_id: CREATION, source: "niho-experience", purpose: "payout" } })], has_more: false });
    const stripe = { accounts: { list } } as unknown as Pick<Stripe, "accounts">;
    const base = { creationId: CREATION, providerId: PROVIDER, rowCreatedAtUtc: "2026-11-28T00:00:00.000Z", stripe };
    assert.equal(await findPayoutAccountByCreationId({ ...base, purpose: "direct" }), ACCOUNT);
    assert.equal(await findPayoutAccountByCreationId({ ...base }), "acct_SamplePayout0001");
  });
});
