import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import type { Pool } from "pg";
import { ExperiencePublicationBlockedError, ExperiencePublicationRepository } from "../src/experience-publication.ts";
import { HostAccounts } from "../src/host-accounts.ts";
import { ownerMailDestinationMissing } from "../src/host-mail-shared.ts";
import { HostNotificationAddresses } from "../src/host-notification-addresses.ts";
import type { HostActor } from "../src/types.ts";
import { createIsolatedDatabase } from "./helpers/isolated-database.ts";

/*
 * #708: a page is published only when an OWNER of the provider has an address the host emails reach (NOTIFICATION_ADDRESS_REQUIRED).
 * A confirmation that is still waiting does not count; a sign-in address or a confirmed choice does; an account that may no
 * longer get this site's emails does not. A page that is already public is not touched. Real schema, synthetic data.
 */
const databaseUrl = process.env.TEST_DATABASE_URL;
const skip = databaseUrl === undefined ? "TEST_DATABASE_URL is not set" : false;
const PROVIDER = "provider-notification-required";
const CHECKS = { manuscriptReady: true, photosReady: true } as const;
const REQUIRED = "NOTIFICATION_ADDRESS_REQUIRED";

const manuscript = {
  lead: "A synthetic lead.", description: "A synthetic description.", facts: { language: "English" },
  highlights: ["A synthetic highlight."], included: ["Synthetic materials"], notIncluded: [],
  knowBeforeYouGo: ["Synthetic guidance."], notSuitableFor: [], timeline: [],
  meetingOverview: "Near a synthetic station.", meetingPointDisclosure: "AFTER_BOOKING", meetingPoint: null,
} as const;

async function withDb(run: (pool: Pool) => Promise<void>): Promise<void> {
  const db = await createIsolatedDatabase(databaseUrl, "notification_required", { max: 4 });
  try { await run(db.pool); } finally { await db.dispose(); }
}

/** A provider with no seller and an ACTIVE host account as its OWNER, who has no address anywhere. */
async function ownerWithoutAddress(pool: Pool): Promise<HostActor> {
  await pool.query("INSERT INTO experience_providers (id) VALUES ($1)", [PROVIDER]);
  const accounts = new HostAccounts(pool);
  const { hostAccountId } = await accounts.provisionHostAccount({ email: "owner-required@example.test", nowUtc: new Date().toISOString() });
  const granted = await accounts.grantProviderOwner({ providerId: PROVIDER, hostAccountId, nowUtc: new Date().toISOString() });
  assert.equal(granted.kind, "granted");
  return { providerId: PROVIDER, nihoUserId: hostAccountId };
}

async function readyDraft(pool: Pool, owner: HostActor, slug: string) {
  const publications = new ExperiencePublicationRepository(pool);
  const draft = await publications.createDraft(owner, { slug, publicTitle: "Synthetic page walk", content: manuscript, currency: "JPY", unitAmount: 4_000 });
  const photoId = randomUUID();
  await publications.addMedia(owner, draft.id, {
    id: photoId, objectKey: `experience-products/${photoId}.jpg`, sourceRefHash: "7".repeat(64),
    width: 640, height: 480, byteSize: 2048, altText: "Synthetic photo", altTextJa: "合成写真", publicCredit: null,
  });
  const current = await publications.getProduct(owner, draft.id);
  await publications.saveSaleTerms(owner, draft.id, {
    expectedDraftVersion: current.version, expectedStateVersion: null, expectedSaleTermsVersion: null,
    saleTerms: {
      offerPrices: null, childPricing: null, minimumParticipants: 2, minimumChargeableParticipants: 3, maxPartySize: 6,
      cancellationPolicy: "CUSTOM", cancellationWindowMinutesBeforeStart: 90, cancellationRefundBasisPoints: 3_750,
      minimumAttendance: 4, bookingQuestions: [], conditionsVersion: null,
    } as never,
    checks: CHECKS,
  });
  return { publications, draft: await publications.getProduct(owner, draft.id) };
}

const pageBlockers = (publications: ExperiencePublicationRepository, owner: HostActor, productId: string) =>
  publications.getPublicationBlockers(owner, productId, CHECKS, null, "PAGE");

describe("NOTIFICATION_ADDRESS_REQUIRED (#708)", { skip }, () => {
  it("is a page blocker while no OWNER has an address, and the publish is refused with it", async () => {
    await withDb(async (pool) => {
      const owner = await ownerWithoutAddress(pool);
      const { publications, draft } = await readyDraft(pool, owner, "no-address-walk");
      assert.deepEqual(await pageBlockers(publications, owner, draft.id), [REQUIRED]);
      assert.ok((await publications.getPublicationBlockers(owner, draft.id, CHECKS, "publication-consent-synthetic-v1")).includes(REQUIRED), "the booking scope names it too");
      await assert.rejects(
        publications.publishPage(owner, draft.id, { expectedDraftVersion: draft.version, expectedStateVersion: null, checks: CHECKS }),
        (error: unknown) => error instanceof ExperiencePublicationBlockedError && error.blockers.includes(REQUIRED),
      );
      assert.equal(await publications.getPublicBySlug(draft.slug), null);
    });
  });

  it("does not count an address that is only waiting for its confirmation link", async () => {
    await withDb(async (pool) => {
      const owner = await ownerWithoutAddress(pool);
      const { publications, draft } = await readyDraft(pool, owner, "pending-address-walk");
      const change = await new HostNotificationAddresses(pool).requestChange({ nihoUserId: owner.nihoUserId, providerId: PROVIDER, email: "waiting@example.test" });
      assert.equal(change.kind, "PENDING");
      assert.deepEqual(await pageBlockers(publications, owner, draft.id), [REQUIRED]);
    });
  });

  it("counts a sign-in address or a confirmed choice, and then the page publishes", async () => {
    await withDb(async (pool) => {
      const owner = await ownerWithoutAddress(pool);
      const { publications, draft } = await readyDraft(pool, owner, "address-walk");
      await pool.query("INSERT INTO host_notification_addresses (niho_user_id,login_email,login_email_at) VALUES ($1,'sign-in@example.test',clock_timestamp())", [owner.nihoUserId]);
      assert.deepEqual(await pageBlockers(publications, owner, draft.id), []);
      await pool.query("UPDATE host_notification_addresses SET login_email=NULL, login_email_at=NULL, override_email='chosen@example.test', override_confirmed_at=clock_timestamp() WHERE niho_user_id=$1", [owner.nihoUserId]);
      assert.deepEqual(await pageBlockers(publications, owner, draft.id), [], "a confirmed choice counts without a sign-in address");
      const state = await publications.publishPage(owner, draft.id, { expectedDraftVersion: draft.version, expectedStateVersion: null, checks: CHECKS });
      assert.ok(state.currentPublicationId !== null);
    });
  });

  it("does not count an address the host account may no longer use, nor an EDITOR's address", async () => {
    await withDb(async (pool) => {
      const owner = await ownerWithoutAddress(pool);
      const { publications, draft } = await readyDraft(pool, owner, "unusable-address-walk");
      await pool.query("INSERT INTO host_notification_addresses (niho_user_id,login_email,login_email_at) VALUES ('editor-synthetic','editor@example.test',clock_timestamp())");
      await pool.query("INSERT INTO provider_memberships (provider_id,niho_user_id,role) VALUES ($1,'editor-synthetic','EDITOR')", [PROVIDER]);
      assert.deepEqual(await pageBlockers(publications, owner, draft.id), [REQUIRED], "only an OWNER's address is the host's");
      await pool.query("INSERT INTO host_notification_addresses (niho_user_id,login_email,login_email_at) VALUES ($1,'owner@example.test',clock_timestamp())", [owner.nihoUserId]);
      assert.deepEqual(await pageBlockers(publications, owner, draft.id), []);
      const missing = async () => { const client = await pool.connect(); try { return await ownerMailDestinationMissing(client, PROVIDER); } finally { client.release(); } };
      assert.equal(await missing(), false);
      assert.equal(await new HostAccounts(pool).suspendHostAccount({ hostAccountId: owner.nihoUserId, nowUtc: new Date().toISOString() }), "CHANGED");
      assert.equal(await missing(), true, "a suspended account's address is not a destination");
    });
  });

  it("does not apply to a provider with no OWNER at all (registered by NIHO's staff, nobody to notify)", async () => {
    await withDb(async (pool) => {
      await pool.query("INSERT INTO experience_providers (id) VALUES ($1)", [PROVIDER]);
      const client = await pool.connect();
      try { assert.equal(await ownerMailDestinationMissing(client, PROVIDER), false); } finally { client.release(); }
      await pool.query("INSERT INTO provider_memberships (provider_id,niho_user_id,role) VALUES ($1,'editor-only','EDITOR')", [PROVIDER]);
      const again = await pool.connect();
      try { assert.equal(await ownerMailDestinationMissing(again, PROVIDER), false, "an EDITOR is not the host"); } finally { again.release(); }
    });
  });

  it("does not stop a page that is already public until its next publish", async () => {
    await withDb(async (pool) => {
      const owner = await ownerWithoutAddress(pool);
      const { publications, draft } = await readyDraft(pool, owner, "already-public-walk");
      await pool.query("INSERT INTO host_notification_addresses (niho_user_id,login_email,login_email_at) VALUES ($1,'owner@example.test',clock_timestamp())", [owner.nihoUserId]);
      const state = await publications.publishPage(owner, draft.id, { expectedDraftVersion: draft.version, expectedStateVersion: null, checks: CHECKS });
      await pool.query("DELETE FROM host_notification_addresses WHERE niho_user_id=$1", [owner.nihoUserId]);
      assert.ok(await publications.getPublicBySlug(draft.slug), "the public page stays");
      assert.equal((await publications.getState(owner, draft.id))?.version, state.version);
      await assert.rejects(
        publications.publishPage(owner, draft.id, { expectedDraftVersion: draft.version, expectedStateVersion: state.version, checks: CHECKS }),
        (error: unknown) => error instanceof ExperiencePublicationBlockedError && error.blockers.includes(REQUIRED),
      );
      assert.ok(await publications.getPublicBySlug(draft.slug), "a refused publish leaves the public page as it was");
    });
  });
});
