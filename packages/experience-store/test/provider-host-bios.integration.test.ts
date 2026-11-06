import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { StoreAccessDeniedError, StoreConflictError, StoreValidationError } from "../src/errors.ts";
import { HOST_BIO_CONSENT_VERSION } from "../src/host-bio-rules.ts";
import { ProviderHostBioRepository, hostBioSourceFingerprint } from "../src/provider-host-bios.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;

describe("provider host bio persistence", { skip: databaseUrl === undefined ? "TEST_DATABASE_URL is not set" : false }, () => {
  it("lets only the current OWNER save/withdraw with CAS and publishes English only for the current Japanese text", async () => {
    const { Pool } = await import("pg");
    const schema = `host_bio_${randomUUID().replaceAll("-", "")}`;
    const pool = new Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });
    try {
      await pool.query(`CREATE SCHEMA "${schema}"`);
      const migrations = (await readdir(new URL("../migrations/", import.meta.url))).filter((name) => /^\d{4}.*\.sql$/.test(name)).sort();
      for (const name of migrations) await pool.query(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));

      const owner = { providerId: "provider-bio-synthetic", nihoUserId: "owner-bio-synthetic" } as const;
      const editor = { providerId: owner.providerId, nihoUserId: "editor-bio-synthetic" } as const;
      const viewer = { providerId: owner.providerId, nihoUserId: "viewer-bio-synthetic" } as const;
      const otherOwner = { providerId: "provider-bio-other", nihoUserId: "owner-bio-other" } as const;
      await pool.query("INSERT INTO experience_providers (id) VALUES ($1),($2)", [owner.providerId, otherOwner.providerId]);
      await pool.query(
        `INSERT INTO provider_memberships (provider_id,niho_user_id,role) VALUES
           ($1,$2,'OWNER'),($1,$3,'EDITOR'),($1,$4,'VIEWER'),($5,$6,'OWNER')`,
        [owner.providerId, owner.nihoUserId, editor.nihoUserId, viewer.nihoUserId, otherOwner.providerId, otherOwner.nihoUserId],
      );
      await pool.query(
        `INSERT INTO experience_host_seller_profiles
          (provider_id,legacy_provider_id,provider_display_name,seller_niho_account_ref,stripe_connect_account_ref,seller_display_name)
         VALUES ($1,'legacy-bio-synthetic','Synthetic Provider',$2,'acct_BioSynthetic','Synthetic Legal Seller')`,
        [owner.providerId, owner.nihoUserId],
      );
      await pool.query(
        `INSERT INTO experience_products
           (provider_id,id,slug,status,public_title,content,currency,unit_amount,cancellation_terms_ref,
            seller_niho_account_ref,stripe_connect_account_ref,seller_display_name)
         VALUES ($1,'product-bio','synthetic-bio-page','PUBLISHED','Synthetic bio page','{}','JPY',5000,'synthetic-terms',$2,'acct_BioSynthetic','Synthetic Legal Seller')`,
        [owner.providerId, owner.nihoUserId],
      );
      const publication = await pool.query<{ id: string }>(
        `INSERT INTO experience_product_publications
           (provider_id,product_id,draft_version,slug,public_title,content,currency,unit_amount,cancellation_terms_ref,
            seller_niho_account_ref,stripe_connect_account_ref,seller_display_name,consent_version,published_by_niho_user_id)
         VALUES ($1,'product-bio',1,'synthetic-bio-page','Synthetic bio page','{}','JPY',5000,'synthetic-terms',$2,
                 'acct_BioSynthetic','Synthetic Legal Seller','publication-v1',$2) RETURNING id::text`,
        [owner.providerId, owner.nihoUserId],
      );
      await pool.query(
        `INSERT INTO experience_product_publication_states (provider_id,product_id,current_publication_id,first_published_at)
         VALUES ($1,'product-bio',$2,clock_timestamp())`,
        [owner.providerId, publication.rows[0]!.id],
      );

      const repository = new ProviderHostBioRepository(pool);
      const save = (actor: typeof owner | typeof editor | typeof viewer | typeof otherOwner, bioJa: string, bioEn: string | null, expectedVersion: number | null) =>
        repository.save(actor, { bioJa, bioEn, expectedVersion, consentVersion: HOST_BIO_CONSENT_VERSION });

      assert.deepEqual(await repository.getForOwner(owner), { version: 0, bioJa: null, bioEn: null, englishConfirmed: false, consentVersion: null, updatedAtUtc: null });
      assert.equal(await repository.getPublicBySlug("synthetic-bio-page"), null);
      for (const actor of [editor, viewer]) {
        await assert.rejects(() => repository.getForOwner(actor), StoreAccessDeniedError);
        await assert.rejects(() => save(actor, "編集者の文", null, null), StoreAccessDeniedError);
      }
      await assert.rejects(() => repository.save(owner, { bioJa: "紹介", bioEn: null, expectedVersion: null, consentVersion: "host-bio-consent-v0" }), StoreValidationError);

      // First save: concurrent first saves cannot both succeed.
      const firstSaves = await Promise.allSettled([
        save(owner, "  鎌倉で茶道を教えています。\r\n\r\n\r\n合成データです。 ", "I teach tea ceremony in Kamakura.\n\nSynthetic data.", null),
        save(owner, "鎌倉で茶道を教えています。", null, null),
      ]);
      assert.equal(firstSaves.filter((result) => result.status === "fulfilled").length, 1);
      const rejectedFirst = firstSaves.find((result) => result.status === "rejected");
      assert.ok(rejectedFirst?.status === "rejected" && rejectedFirst.reason instanceof StoreConflictError);
      const initial = await repository.getForOwner(owner);
      assert.equal(initial.version, 1);
      assert.equal(initial.consentVersion, HOST_BIO_CONSENT_VERSION);

      // Settle on a known state with English confirmed.
      const v2 = await save(owner, "  鎌倉で茶道を教えています。\r\n\r\n\r\n合成データです。 ", "I teach tea ceremony in Kamakura.\n\nSynthetic data.", 1);
      assert.equal(v2.version, 2);
      assert.equal(v2.bioJa, "鎌倉で茶道を教えています。\n\n合成データです。");
      assert.equal(v2.englishConfirmed, true);
      const stored = await pool.query("SELECT english_source_fingerprint,consented_by_niho_user_id FROM provider_host_bios WHERE provider_id=$1", [owner.providerId]);
      assert.equal(stored.rows[0].english_source_fingerprint, hostBioSourceFingerprint(v2.bioJa!));
      assert.equal(stored.rows[0].consented_by_niho_user_id, owner.nihoUserId);
      assert.deepEqual(await repository.getPublicBySlug("synthetic-bio-page"), { ja: "鎌倉で茶道を教えています。\n\n合成データです。", en: "I teach tea ceremony in Kamakura.\n\nSynthetic data." });
      const publicText = JSON.stringify(await repository.getPublicBySlug("synthetic-bio-page"));
      assert.doesNotMatch(publicText, /provider-bio|owner-bio|consent/);

      // Stale version and another provider's OWNER are rejected.
      await assert.rejects(() => save(owner, "古い版から", null, 1), StoreConflictError);
      await assert.rejects(() => save(owner, "既にある", null, null), StoreConflictError);
      await assert.rejects(() => repository.withdraw(otherOwner, 2), StoreConflictError);
      const crossProvider = { providerId: owner.providerId, nihoUserId: otherOwner.nihoUserId };
      await assert.rejects(() => repository.save(crossProvider, { bioJa: "他社の文", bioEn: null, expectedVersion: 2, consentVersion: HOST_BIO_CONSENT_VERSION }), StoreAccessDeniedError);
      await assert.rejects(() => repository.withdraw(crossProvider, 2), StoreAccessDeniedError);
      assert.equal((await repository.getForOwner(otherOwner)).version, 0);
      assert.equal((await repository.getForOwner(owner)).version, 2);

      // Japanese changed without (re)confirmed English: no English is saved or published.
      const v3 = await save(owner, "鎌倉で茶道を教えて20年になります。", null, 2);
      assert.equal(v3.bioEn, null);
      assert.equal(v3.englishConfirmed, false);
      assert.deepEqual(await repository.getPublicBySlug("synthetic-bio-page"), { ja: "鎌倉で茶道を教えて20年になります。", en: null });

      // A direct Japanese change after confirmation breaks the fingerprint: readers drop the English.
      const v4 = await save(owner, "鎌倉で茶道を教えて20年になります。", "I have taught tea ceremony in Kamakura for 20 years.", 3);
      assert.equal(v4.englishConfirmed, true);
      await pool.query("UPDATE provider_host_bios SET bio_ja='直接書き換えた日本語' WHERE provider_id=$1", [owner.providerId]);
      assert.deepEqual(await repository.getPublicBySlug("synthetic-bio-page"), { ja: "直接書き換えた日本語", en: null });
      const drifted = await repository.getForOwner(owner);
      assert.equal(drifted.bioEn, "I have taught tea ceremony in Kamakura for 20 years.");
      assert.equal(drifted.englishConfirmed, false);

      // A stopped publication or an inactive OWNER shows no bio; an unknown slug neither.
      await pool.query("UPDATE experience_product_publication_states SET self_stopped_at=clock_timestamp() WHERE provider_id=$1", [owner.providerId]);
      assert.equal(await repository.getPublicBySlug("synthetic-bio-page"), null);
      await pool.query("UPDATE experience_product_publication_states SET self_stopped_at=NULL WHERE provider_id=$1", [owner.providerId]);
      assert.equal(await repository.getPublicBySlug("not-published-page"), null);
      await pool.query("UPDATE provider_memberships SET active=false WHERE provider_id=$1 AND niho_user_id=$2", [owner.providerId, owner.nihoUserId]);
      assert.equal(await repository.getPublicBySlug("synthetic-bio-page"), null);
      await assert.rejects(() => repository.getForOwner(owner), StoreAccessDeniedError);
      await pool.query("UPDATE provider_memberships SET active=true WHERE provider_id=$1 AND niho_user_id=$2", [owner.providerId, owner.nihoUserId]);

      // DB CHECKs back up the Store validation.
      const insertRaw = (bioJa: string, bioEn: string | null, fingerprint: string | null) => pool.query(
        `INSERT INTO provider_host_bios (provider_id,bio_ja,bio_en,english_source_fingerprint,consent_version,consented_at,consented_by_niho_user_id)
         VALUES ($1,$2,$3,$4,$5,clock_timestamp(),$6)`,
        [otherOwner.providerId, bioJa, bioEn, fingerprint, HOST_BIO_CONSENT_VERSION, otherOwner.nihoUserId],
      );
      const checkViolation = { code: "23514" };
      await assert.rejects(() => insertRaw("タブ\tあり", null, null), checkViolation);
      await assert.rejects(() => insertRaw("CR\rあり", null, null), checkViolation);
      await assert.rejects(() => insertRaw(" 前に空白", null, null), checkViolation);
      await assert.rejects(() => insertRaw("後ろに改行\n", null, null), checkViolation);
      await assert.rejects(() => insertRaw("", null, null), checkViolation);
      await assert.rejects(() => insertRaw("あ".repeat(601), null, null), checkViolation);
      await assert.rejects(() => insertRaw("紹介", "a".repeat(1501), hostBioSourceFingerprint("紹介")), checkViolation);
      await assert.rejects(() => insertRaw("紹介", "Intro", null), checkViolation);
      await assert.rejects(() => insertRaw("紹介", null, hostBioSourceFingerprint("紹介")), checkViolation);
      await assert.rejects(() => insertRaw("紹介", "Intro", "NOT-A-HEX"), checkViolation);
      // The consenting person must be a member of the same provider.
      await assert.rejects(() => pool.query(
        `INSERT INTO provider_host_bios (provider_id,bio_ja,consent_version,consented_at,consented_by_niho_user_id)
         VALUES ($1,'紹介',$2,clock_timestamp(),$3)`,
        [otherOwner.providerId, HOST_BIO_CONSENT_VERSION, owner.nihoUserId],
      ), { code: "23503" });
      await insertRaw("𠮷".repeat(600), "a".repeat(1500), hostBioSourceFingerprint("𠮷".repeat(600)));

      // Withdrawal deletes the row and the public page stops showing it.
      await assert.rejects(() => repository.withdraw(owner, 3), StoreConflictError);
      assert.deepEqual(await repository.withdraw(owner, 4), { version: 0, bioJa: null, bioEn: null, englishConfirmed: false, consentVersion: null, updatedAtUtc: null });
      assert.equal(await repository.getPublicBySlug("synthetic-bio-page"), null);
      const remaining = await pool.query("SELECT count(*)::int AS count FROM provider_host_bios WHERE provider_id=$1", [owner.providerId]);
      assert.equal(remaining.rows[0].count, 0);
      await assert.rejects(() => repository.withdraw(owner, 4), StoreConflictError);
      assert.equal((await save(owner, "撤回後に書き直しました。", null, null)).version, 1);
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
      await pool.end();
    }
  });
});
