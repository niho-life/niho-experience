import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { StoreConflictError } from "../src/errors.ts";
import { ProviderSellerDisclosureRepository } from "../src/provider-seller-disclosures.ts";
import { createIsolatedDatabase } from "./helpers/isolated-database.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;

describe("provider seller disclosure persistence", { skip: databaseUrl === undefined ? "TEST_DATABASE_URL is not set" : false }, () => {
  it("enforces OWNER/CAS/idempotency, fails public reads closed on seller-account drift, and leaves booking snapshots unchanged", async () => {
    const db = await createIsolatedDatabase(databaseUrl, "seller_disclosure", { max: 4 });
    const pool = db.pool;
    try {

      const actor = { providerId: "provider-seller-synthetic", nihoUserId: "owner-seller-synthetic" } as const;
      const concurrentActor = { providerId: "provider-seller-concurrent", nihoUserId: "owner-seller-concurrent" } as const;
      await pool.query("INSERT INTO experience_providers (id) VALUES ($1)", [actor.providerId]);
      await pool.query("INSERT INTO provider_memberships (provider_id,niho_user_id,role) VALUES ($1,$2,'OWNER')", [actor.providerId, actor.nihoUserId]);
      await pool.query(
        `INSERT INTO experience_host_seller_profiles
          (provider_id,legacy_provider_id,provider_display_name,seller_niho_account_ref,stripe_connect_account_ref,seller_display_name)
         VALUES ($1,'legacy-seller-synthetic','Synthetic Provider',$2,'acct_SellerSynthetic','Synthetic Legal Seller')`,
        [actor.providerId, actor.nihoUserId],
      );
      await pool.query("INSERT INTO experience_providers (id) VALUES ($1)", [concurrentActor.providerId]);
      await pool.query("INSERT INTO provider_memberships (provider_id,niho_user_id,role) VALUES ($1,$2,'OWNER')", [concurrentActor.providerId, concurrentActor.nihoUserId]);
      await pool.query(
        `INSERT INTO experience_host_seller_profiles
          (provider_id,legacy_provider_id,provider_display_name,seller_niho_account_ref,stripe_connect_account_ref,seller_display_name)
         VALUES ($1,'legacy-seller-concurrent','Concurrent Provider',$2,'acct_SellerConcurrent','Concurrent Legal Seller')`,
        [concurrentActor.providerId, concurrentActor.nihoUserId],
      );
      const repository = new ProviderSellerDisclosureRepository(pool);
      assert.deepEqual(await repository.getForOwner(actor), { sellerDisplayName: "Synthetic Legal Seller", disclosure: null });

      const commandId = randomUUID();
      const input = {
        method: "NATIVE" as const, sellerKind: "PERSON" as const, sellerDisplayName: "Synthetic Legal Seller", representativeName: null,
        publicAddress: "1-2 Synthetic,\nKamakura", publicPhone: "046-000-0000", publicEmail: "public@example.test",
        consentVersion: "seller-public-disclosure-v1", accepted: true as const,
      };
      const firstResults = await Promise.all([
        repository.save(actor, { commandId, expectedVersion: null, disclosure: input }),
        repository.save(actor, { commandId, expectedVersion: null, disclosure: input }),
      ]);
      const saved = firstResults[0];
      assert.equal(saved.version, 1);
      assert.deepEqual(firstResults[1], saved);
      const firstRows = await pool.query("SELECT version FROM provider_seller_disclosures WHERE provider_id=$1", [actor.providerId]);
      assert.deepEqual(firstRows.rows, [{ version: "1" }]);

      const concurrentInput = { ...input, sellerDisplayName: "Concurrent Legal Seller", publicAddress: "9-9 Synthetic concurrent address" };
      const distinctInitialResults = await Promise.allSettled([
        repository.save(concurrentActor, { commandId: randomUUID(), expectedVersion: null, disclosure: concurrentInput }),
        repository.save(concurrentActor, { commandId: randomUUID(), expectedVersion: null, disclosure: concurrentInput }),
      ]);
      const fulfilledInitial = distinctInitialResults.filter((result) => result.status === "fulfilled");
      const rejectedInitial = distinctInitialResults.filter((result) => result.status === "rejected");
      assert.equal(fulfilledInitial.length, 1);
      assert.equal(rejectedInitial.length, 1);
      assert.ok(rejectedInitial[0]!.reason instanceof StoreConflictError);
      const concurrentRows = await pool.query("SELECT version FROM provider_seller_disclosures WHERE provider_id=$1", [concurrentActor.providerId]);
      assert.deepEqual(concurrentRows.rows, [{ version: "1" }]);
      const concurrentReceipts = await pool.query("SELECT count(*)::int AS count FROM provider_seller_disclosure_commands WHERE provider_id=$1", [concurrentActor.providerId]);
      assert.equal(concurrentReceipts.rows[0]!.count, 1);

      const receiptColumns = await pool.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='provider_seller_disclosure_commands'",
      );
      assert.equal(receiptColumns.rows.some((row) => row.column_name === "result_json"), false);
      const receipt = await pool.query<{ receipt: unknown }>(
        "SELECT to_jsonb(command) AS receipt FROM provider_seller_disclosure_commands command WHERE provider_id=$1 AND command_id=$2",
        [actor.providerId, commandId],
      );
      const receiptText = JSON.stringify(receipt.rows[0]!.receipt);
      assert.doesNotMatch(receiptText, /Synthetic, Kamakura|046-000-0000|public@example\.test/);
      assert.match(receiptText, /SAVE/);
      await assert.rejects(() => repository.save(actor, { commandId: randomUUID(), expectedVersion: null, disclosure: input }), StoreConflictError);
      const repeatedCommand = randomUUID();
      const repeated = await Promise.all([
        repository.save(actor, { commandId: repeatedCommand, expectedVersion: 1, disclosure: input }),
        repository.save(actor, { commandId: repeatedCommand, expectedVersion: 1, disclosure: input }),
      ]);
      assert.equal(repeated[0].version, 2);
      assert.deepEqual(repeated[1], repeated[0]);
      await assert.rejects(() => repository.save(actor, {
        commandId: randomUUID(), expectedVersion: 2, disclosure: { ...input, sellerDisplayName: "Another Seller" },
      }), StoreConflictError);

      await pool.query(
        `INSERT INTO experience_products
           (provider_id,id,slug,status,public_title,content,currency,unit_amount,cancellation_terms_ref,
            seller_niho_account_ref,stripe_connect_account_ref,seller_display_name)
         VALUES ($1,'product-seller','synthetic-seller-page','PUBLISHED','Synthetic seller page','{}','JPY',5000,'synthetic-terms',$2,'acct_SellerSynthetic','Synthetic Legal Seller')`,
        [actor.providerId, actor.nihoUserId],
      );
      const publication = await pool.query<{ id: string }>(
        `INSERT INTO experience_product_publications
           (provider_id,product_id,draft_version,slug,public_title,content,currency,unit_amount,cancellation_terms_ref,
            seller_niho_account_ref,stripe_connect_account_ref,seller_display_name,consent_version,published_by_niho_user_id)
         VALUES ($1,'product-seller',1,'synthetic-seller-page','Synthetic seller page','{}','JPY',5000,'synthetic-terms',$2,
                 'acct_SellerSynthetic','Synthetic Legal Seller','publication-v1',$2) RETURNING id::text`,
        [actor.providerId, actor.nihoUserId],
      );
      await pool.query(
        `INSERT INTO experience_product_publication_states
           (provider_id,product_id,current_publication_id,first_published_at)
         VALUES ($1,'product-seller',$2,clock_timestamp())`,
        [actor.providerId, publication.rows[0]!.id],
      );
      await pool.query(
        `INSERT INTO schedule_rules
           (provider_id,id,product_id,time_zone,starts_on,local_start_time,duration_minutes,capacity,booking_cutoff_minutes,
            busy_buffer_before_minutes,busy_buffer_after_minutes,recurrence)
         VALUES ($1,'rule-seller','product-seller','Asia/Tokyo','2099-01-01','10:00',60,4,60,0,0,'{"kind":"DAILY"}')`,
        [actor.providerId],
      );
      await pool.query(
        `INSERT INTO schedule_occurrences
           (provider_id,occurrence_id,product_id,rule_id,source_local_date,local_date,local_start_time,time_zone,start_at,end_at,
            duration_minutes,capacity,booking_cutoff_minutes,busy_buffer_before_minutes,busy_buffer_after_minutes,status,rescheduled,schedule_rule_version)
         VALUES ($1,'occurrence-seller','product-seller','rule-seller','2099-01-01','2099-01-01','10:00','Asia/Tokyo',
                 '2099-01-01T01:00:00Z','2099-01-01T02:00:00Z',60,4,60,0,0,'OPEN',false,1)`,
        [actor.providerId],
      );
      const sellerSnapshot = { displayName: "Synthetic Legal Seller", stripeConnectAccountRef: "acct_SellerSynthetic" };
      await pool.query(
        `INSERT INTO bookings
           (public_booking_id,provider_id,product_id,occurrence_id,status,seats,idempotency_key,hold_expires_at,
            occurrence_snapshot,pricing_snapshot,seller_snapshot)
         VALUES ($1,$2,'product-seller','occurrence-seller','HOLD',1,'seller-snapshot-test',clock_timestamp()+interval '1 hour','{}','{}',$3::jsonb)`,
        [randomUUID(), actor.providerId, JSON.stringify(sellerSnapshot)],
      );
      assert.deepEqual(await repository.getPublicBySlug("synthetic-seller-page"), {
        method: "NATIVE", sellerKind: "PERSON", sellerDisplayName: "Synthetic Legal Seller", representativeName: null,
        publicAddress: "1-2 Synthetic,\nKamakura", publicPhone: "046-000-0000", publicEmail: "public@example.test",
      });

      await pool.query("UPDATE experience_product_publication_states SET self_stopped_at=clock_timestamp() WHERE provider_id=$1", [actor.providerId]);
      assert.equal(await repository.getPublicBySlug("synthetic-seller-page"), null);
      await pool.query("UPDATE experience_product_publication_states SET self_stopped_at=NULL WHERE provider_id=$1", [actor.providerId]);
      await pool.query("UPDATE provider_memberships SET active=false WHERE provider_id=$1 AND niho_user_id=$2", [actor.providerId, actor.nihoUserId]);
      assert.equal(await repository.getPublicBySlug("synthetic-seller-page"), null);
      await pool.query("UPDATE provider_memberships SET active=true WHERE provider_id=$1 AND niho_user_id=$2", [actor.providerId, actor.nihoUserId]);
      await pool.query("UPDATE experience_host_seller_profiles SET seller_display_name='Different Legal Seller' WHERE provider_id=$1", [actor.providerId]);
      assert.equal(await repository.getPublicBySlug("synthetic-seller-page"), null);
      await pool.query("UPDATE experience_host_seller_profiles SET seller_display_name='Synthetic Legal Seller' WHERE provider_id=$1", [actor.providerId]);

      await pool.query("UPDATE experience_host_seller_profiles SET stripe_connect_account_ref='acct_DifferentSynthetic' WHERE provider_id=$1", [actor.providerId]);
      assert.equal(await repository.getPublicBySlug("synthetic-seller-page"), null);
      await assert.rejects(() => repository.save(actor, { commandId: randomUUID(), expectedVersion: 2, disclosure: input }), StoreConflictError);
      await pool.query("UPDATE experience_host_seller_profiles SET stripe_connect_account_ref='acct_SellerSynthetic' WHERE provider_id=$1", [actor.providerId]);
      const withdrawCommandId = randomUUID();
      const withdrawn = await repository.withdraw(actor, { commandId: withdrawCommandId, expectedVersion: repeated[0].version });
      assert.equal(withdrawn.method, "WITHDRAWN");
      await assert.rejects(
        () => repository.save(actor, { commandId, expectedVersion: null, disclosure: input }),
        StoreConflictError,
      );
      const current = await repository.getForOwner(actor);
      assert.equal(current.disclosure?.method, "WITHDRAWN");
      assert.equal(current.disclosure?.publicAddress, null);
      assert.equal(current.disclosure?.publicPhone, null);
      assert.equal(current.disclosure?.publicEmail, null);
      const allReceipts = await pool.query<{ receipt: unknown }>(
        "SELECT to_jsonb(command) AS receipt FROM provider_seller_disclosure_commands command WHERE provider_id=$1 ORDER BY created_at",
        [actor.providerId],
      );
      assert.doesNotMatch(JSON.stringify(allReceipts.rows), /Synthetic, Kamakura|046-000-0000|public@example\.test/);
      assert.equal(await repository.getPublicBySlug("synthetic-seller-page"), null);
      const booking = await pool.query("SELECT seller_snapshot FROM bookings WHERE provider_id=$1", [actor.providerId]);
      assert.deepEqual(booking.rows[0]!.seller_snapshot, sellerSnapshot);
    } finally {
      await db.dispose();
    }
  });
});
