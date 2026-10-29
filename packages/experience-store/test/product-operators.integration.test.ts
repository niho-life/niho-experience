import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { occurrenceIdFor, type ScheduleRule } from "@niho-experience/experience-domain";
import { StoreAccessDeniedError, StoreConflictError } from "../src/errors.ts";
import { ChannelRuntime } from "../src/channels.ts";
import { ProductOperatorRepository } from "../src/product-operators.ts";
import { ExperienceStore } from "../src/repository.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
const command = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;

describe("PostgreSQL product operators", { skip: databaseUrl === undefined }, () => {
  it("isolates products, accepts once, and serializes revoke before calendar command replay", async () => {
    const { Pool } = await import("pg");
    const schema = `product_operators_${randomUUID().replaceAll("-", "")}`;
    const pool = new Pool({ connectionString: databaseUrl, max: 6, options: `-c search_path=${schema}` });
    try {
      await pool.query(`CREATE SCHEMA "${schema}"`);
      const migrations = (await readdir(new URL("../migrations/", import.meta.url))).filter((name) => /^\d{4}.*\.sql$/.test(name)).sort();
      for (const name of migrations) await pool.query(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
      await pool.query("INSERT INTO experience_providers (id) VALUES ('provider-a'),('provider-b')");
      await pool.query("INSERT INTO provider_memberships (provider_id,niho_user_id,role) VALUES ('provider-a','owner-a','OWNER'),('provider-b','owner-b','OWNER')");
      const store = new ExperienceStore(pool);
      const ownerA = { providerId: "provider-a", nihoUserId: "owner-a" } as const;
      const ownerB = { providerId: "provider-b", nihoUserId: "owner-b" } as const;
      const createProduct = (owner: { readonly providerId: string; readonly nihoUserId: string }, id: string) => store.createProduct(owner, {
        id, slug: id, status: "PUBLISHED", publicTitle: `Synthetic ${id}`, content: {}, currency: "JPY", unitAmount: 1000,
        cancellationTermsRef: "synthetic-terms", sellerNihoAccountRef: "synthetic-seller",
        stripeConnectAccountRef: `acct_${owner.providerId}`, sellerDisplayName: `Synthetic ${owner.providerId}`,
      });
      await createProduct(ownerA, "tea-a"); await createProduct(ownerA, "tea-b"); await createProduct(ownerB, "tea-c");
      const rule = (id: string): ScheduleRule => ({ id, timeZone: "Asia/Tokyo", startsOn: "2099-01-01", localStartTime: "10:00", durationMinutes: 60,
        capacity: 4, bookingCutoffMinutes: 0, busyBufferBeforeMinutes: 0, busyBufferAfterMinutes: 0, recurrence: { kind: "DAILY" } });
      await store.saveScheduleRule(ownerA, "tea-a", rule("rule-a"), null, command(1));
      await store.saveScheduleRule(ownerA, "tea-b", rule("rule-b"), null, command(2));
      await store.saveScheduleRule(ownerB, "tea-c", rule("rule-c"), null, command(3));

      const operators = new ProductOperatorRepository(pool);
      const admin = { nihoUserId: "synthetic-admin" };
      const created = await operators.createInvitation(admin, { providerId: "provider-a", productId: "tea-a", assignmentLabel: "Synthetic teacher" }, command(10));
      const invitationToken = created.token;
      assert.ok(invitationToken);
      assert.equal(invitationToken.length, 43);
      const repeated = await operators.createInvitation(admin, { providerId: "provider-a", productId: "tea-a", assignmentLabel: "Synthetic teacher" }, command(10));
      assert.equal(repeated.repeated, true);
      assert.equal(repeated.token, undefined);
      assert.equal((await pool.query("SELECT 1 FROM product_operator_invitations WHERE token_hash=$1", [Buffer.from(invitationToken)])).rowCount, 0);
      await assert.rejects(() => operators.prepare(created.invitation.id, `${invitationToken.slice(0, -1)}x`), StoreAccessDeniedError);
      await operators.prepare(created.invitation.id, invitationToken);

      const accepted = await operators.accept(created.invitation.id, invitationToken, "operator-a");
      assert.equal(accepted.active, true);
      assert.equal((await operators.accept(created.invitation.id, invitationToken, "operator-a")).version, accepted.version);
      await assert.rejects(() => operators.accept(created.invitation.id, invitationToken, "operator-b"), StoreConflictError);
      const actor = { providerId: "provider-a", nihoUserId: "operator-a" } as const;
      assert.deepEqual((await store.listCalendarProducts(actor)).map((product) => product.id), ["tea-a"]);
      assert.equal((await store.listSchedule(actor, "tea-a")).length, 1);
      await assert.rejects(() => store.listSchedule(actor, "tea-b"), StoreAccessDeniedError);
      await assert.rejects(() => store.listSchedule({ providerId: "provider-b", nihoUserId: "operator-a" }, "tea-c"), StoreAccessDeniedError);
      await assert.rejects(() => store.getProduct(actor, "tea-a"), StoreAccessDeniedError);
      await assert.rejects(() => store.getGoogleCalendar(actor), StoreAccessDeniedError);
      await assert.rejects(() => store.listInventoryResources(actor), StoreAccessDeniedError);
      await pool.query(
        `INSERT INTO channel_external_accounts
           (id,provider_id,site,external_account_id,display_name,operating_model,active)
         VALUES ('account-a','provider-a','Airbnb','synthetic-private-account','Synthetic account',1,true)`,
      );
      await pool.query(
        `INSERT INTO channel_listings
           (id,provider_id,account_id,product_id,external_product_id,adapter,adapter_version,connection_mode,can_open,can_close,active)
         VALUES
           ('listing-a','provider-a','account-a','tea-a','synthetic-private-a','synthetic','1','BROWSER',true,true,true),
           ('listing-b','provider-a','account-a','tea-b','synthetic-private-b','synthetic','1','BROWSER',true,true,true)`,
      );
      await pool.query(
        `INSERT INTO channel_desired_states
           (listing_id,provider_id,occurrence_id,desired_state,reason,desired_version,mapping_version,source_start_at,source_end_at)
         VALUES
           ('listing-a','provider-a','rule-a@2099-01-01','OPEN','SYNTHETIC',1,1,'2099-01-01T01:00:00Z','2099-01-01T02:00:00Z'),
           ('listing-b','provider-a','rule-b@2099-01-01','OPEN','SYNTHETIC',1,1,'2099-01-01T01:00:00Z','2099-01-01T02:00:00Z')`,
      );
      const channel = new ChannelRuntime(pool, { supportedAdapters: { "Airbnb/synthetic@1": { canOpen: true, canClose: true } } });
      const statuses = await channel.hostStatuses(actor);
      assert.deepEqual(statuses.map((status) => status.occurrenceId), ["rule-a@2099-01-01"]);
      assert.doesNotMatch(JSON.stringify(statuses), /synthetic-private|accountId|externalProduct/i);

      const occurrenceId = occurrenceIdFor("rule-a", "2099-01-01");
      const mutationCommand = command(20);
      const race = await Promise.allSettled([
        store.setOccurrenceSalesState(actor, "tea-a", "rule-a", { occurrenceId, desiredState: "CLOSED" }, null, mutationCommand),
        operators.revokeGrant(admin, "provider-a", "tea-a", "operator-a", accepted.version, command(21)),
      ]);
      assert.equal(race.filter((item) => item.status === "fulfilled").length >= 1, true);
      await assert.rejects(
        () => store.setOccurrenceSalesState(actor, "tea-a", "rule-a", { occurrenceId, desiredState: "CLOSED" }, null, mutationCommand),
        StoreAccessDeniedError,
      );
      await assert.rejects(() => store.saveScheduleRule(actor, "tea-a", rule("after-revoke"), null, command(22)), StoreAccessDeniedError);
      await assert.rejects(() => channel.hostStatuses(actor), StoreAccessDeniedError);

      const replacement = await operators.createInvitation(admin, { providerId: "provider-a", productId: "tea-a", assignmentLabel: "Replacement teacher" }, command(23));
      const reactivated = await operators.accept(replacement.invitation.id, replacement.token!, "operator-a");
      assert.equal(reactivated.active, true);
      const pastRevoke = await operators.revokeGrant(admin, "provider-a", "tea-a", "operator-a", accepted.version, command(21));
      assert.equal(pastRevoke.active, false);
      assert.deepEqual((await store.listCalendarProducts(actor)).map((product) => product.id), ["tea-a"]);
      await operators.revokeGrant(admin, "provider-a", "tea-a", "operator-a", reactivated.version, command(24));

      const expiring = await operators.createInvitation(admin, { providerId: "provider-a", productId: "tea-a", assignmentLabel: "Expired teacher" }, command(30));
      await pool.query("UPDATE product_operator_invitations SET created_at=statement_timestamp()-interval '8 days',expires_at=statement_timestamp()-interval '1 day' WHERE id=$1", [expiring.invitation.id]);
      await assert.rejects(() => operators.prepare(expiring.invitation.id, expiring.token!), StoreAccessDeniedError);
      const pending = await operators.createInvitation(admin, { providerId: "provider-a", productId: "tea-a", assignmentLabel: "Revoked teacher" }, command(31));
      await operators.revokeInvitation(admin, pending.invitation.id, pending.invitation.revision, command(32));
      await assert.rejects(() => operators.prepare(pending.invitation.id, pending.token!), StoreAccessDeniedError);
      assert.equal((await operators.revokeInvitation(admin, pending.invitation.id, pending.invitation.revision, command(32))).state, "REVOKED");
      await assert.rejects(() => operators.revokeInvitation(admin, pending.invitation.id, pending.invitation.revision + 1, command(32)), StoreConflictError);
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    }
  });
});
