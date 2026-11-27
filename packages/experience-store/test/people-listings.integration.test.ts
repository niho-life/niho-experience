import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import type { Pool } from "pg";
import { StoreAccessDeniedError, StoreConflictError, StoreValidationError } from "../src/errors.ts";
import { ExperiencePublicationRepository } from "../src/experience-publication.ts";
import { MemberProfileRepository, type MemberProfileRef } from "../src/member-profiles.ts";
import { PeopleListingRepository } from "../src/people-listings.ts";
import { createIsolatedDatabase } from "./helpers/isolated-database.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
const ADMIN = { nihoUserId: "adm_synthetic_people" } as const;
const JA = { role: "金継ぎ職人", area: "長谷", quote: null, intro: "合成の紹介文です。" };
const EN = { role: "Kintsugi artist", area: "Hase", quote: null, intro: "Synthetic introduction." };
const draft = (name: string) => ({ name, ja: JA, en: null, photo: null, expectedVersion: null });

async function fixture(pool: Pool) {
  const publications = new ExperiencePublicationRepository(pool);
  const people = new PeopleListingRepository(pool);
  const profiles = new MemberProfileRepository(pool);
  const { providerId } = await publications.createAdminProvider(ADMIN, { publicDisplayName: "Synthetic Business", providerKind: "BUSINESS", consentVersion: "public-profile-v1" });
  async function member(memberId: string, role: "OWNER" | "COHOST" | "EDITOR"): Promise<MemberProfileRef> {
    await pool.query("INSERT INTO provider_memberships (provider_id,niho_user_id,role,active) VALUES ($1,$2,$3,true)", [providerId, memberId, role]);
    return { providerId, memberId };
  }
  const photo = async (ref: MemberProfileRef, version: number, admin?: string) => {
    const id = randomUUID();
    return profiles.addPhoto(ref, version, "合成写真", { id, objectKey: `experience-provider-media/${id}.jpg`, sourceRefHash: "a".repeat(64), width: 800, height: 800, byteSize: 4096 }, admin);
  };
  const list = (ref: MemberProfileRef, slug: string, sortOrder = 100) => people.adminSave(ADMIN.nihoUserId, null, null, ref, { slug, sortOrder });
  const product = async (slug: string, current: boolean) => {
    await pool.query(
      `INSERT INTO experience_products (provider_id,id,slug,status,public_title,currency,unit_amount,cancellation_terms_ref,seller_niho_account_ref,stripe_connect_account_ref,seller_display_name)
       VALUES ($1,$2,$2,$3,$2,'JPY',5000,'terms','seller','acct_x','Seller')`, [providerId, slug, current ? "PUBLISHED" : "DRAFT"],
    );
    if (!current) return;
    const versions = await pool.query<{ id: string }>(
      `INSERT INTO experience_product_publications (provider_id,product_id,draft_version,slug,public_title,content,currency,unit_amount,cancellation_terms_ref,
         seller_niho_account_ref,stripe_connect_account_ref,seller_display_name,consent_version,published_by_niho_user_id,sale_terms_version,sale_terms_snapshot)
       VALUES ($1,$2,1,$2,$2,'{}','JPY',5000,'terms','seller','acct_x','Seller','consent-v1','member-owner',1,'{"fixture":true}'::jsonb) RETURNING id::text`, [providerId, slug],
    );
    await pool.query("INSERT INTO experience_product_publication_states (provider_id,product_id,current_publication_id,booking_publication_id,first_published_at) VALUES ($1,$2,$3::bigint,$3::bigint,clock_timestamp())", [providerId, slug, versions.rows[0]!.id]);
  };
  return { providerId, publications, people, profiles, member, photo, list, product };
}

describe("Member profiles and people listings", { skip: databaseUrl === undefined }, () => {
  it("separates listing, Japanese and English publication, draft edits, and photo revocation", async () => {
    const db = await createIsolatedDatabase(databaseUrl, "member_profile_public");
    try {
      const { people, profiles, publications, member, photo, list, product } = await fixture(db.pool);
      const owner = await member("member-owner", "OWNER");
      const cohost = await member("member-cohost", "COHOST");
      const editor = await member("member-editor", "EDITOR");
      await product("public-product", true);
      await assert.rejects(profiles.save(editor, draft("編集者")), StoreAccessDeniedError);
      await assert.rejects(list(editor, "editor-person"), StoreValidationError);
      const initial = await profiles.save(cohost, draft("名前"));
      const withPhoto = await photo(cohost, initial.draft!.version);
      const photoId = withPhoto.draft!.photo!.assetId;
      const listed = await list(cohost, "member-person");
      await assert.rejects(list(cohost, "duplicate"), StoreConflictError);
      assert.equal(await people.getPublicBySlug("member-person"), null);
      assert.equal(await publications.getPublicProviderMediaAsset(photoId), null);
      await assert.rejects(profiles.saveProductSelection(owner, "public-product", [cohost], []), StoreValidationError);
      await assert.rejects(profiles.publish(cohost, withPhoto.draft!.version, false), StoreValidationError);

      const publishedJa = await profiles.publish(cohost, withPhoto.draft!.version, true);
      assert.equal((await people.getPublicBySlug("member-person"))?.name, "名前");
      assert.ok(await publications.getPublicProviderMediaAsset(photoId));
      assert.equal(await publications.getPublicProviderMediaAsset(photoId, false), null);
      await assert.rejects(profiles.saveProductSelection(cohost, "public-product", [cohost], []), StoreAccessDeniedError);
      await profiles.saveProductSelection(owner, "public-product", [cohost], []);
      await assert.rejects(profiles.saveProductSelection(owner, "public-product", [], []), StoreConflictError);
      await assert.rejects(profiles.saveProductSelection(owner, "public-product", [owner, cohost, editor, owner], [cohost]), StoreValidationError);
      assert.equal((await profiles.listPublicForExperience("public-product", "ja"))[0]?.name, "名前");
      assert.deepEqual(await profiles.listPublicForExperience("public-product", "en"), []);
      assert.deepEqual((await people.getPublicBySlug("member-person"))?.experienceSlugs, ["public-product"]);

      const updated = await profiles.save(cohost, { name: "更新した名前", ja: JA, en: EN, photo: withPhoto.draft!.photo, expectedVersion: withPhoto.draft!.version });
      assert.equal(updated.publication?.id, publishedJa.publication?.id);
      assert.equal((await people.getPublicBySlug("member-person"))?.name, "名前");
      assert.deepEqual(await profiles.listPublicForExperience("public-product", "en"), []);
      const publishedEn = await profiles.publish(cohost, updated.draft!.version, true);
      assert.equal((await profiles.listPublicForExperience("public-product", "en"))[0]?.text.intro, EN.intro);

      await people.adminWithdraw(ADMIN.nihoUserId, listed.id, 1);
      assert.equal(await people.getPublicBySlug("member-person"), null);
      assert.equal((await profiles.listPublicForExperience("public-product", "en"))[0]?.slug, null);
      assert.ok(await publications.getPublicProviderMediaAsset(photoId, false));
      await list(cohost, "member-person");
      await db.pool.query("UPDATE provider_memberships SET active=false WHERE provider_id=$1 AND niho_user_id=$2", [cohost.providerId, cohost.memberId]);
      assert.deepEqual(await people.listPublic(), []);
      assert.deepEqual(await profiles.listPublicForExperience("public-product", "ja"), []);
      assert.equal(await publications.getPublicProviderMediaAsset(photoId), null);
      await db.pool.query("UPDATE provider_memberships SET active=true WHERE provider_id=$1 AND niho_user_id=$2", [cohost.providerId, cohost.memberId]);
      await profiles.withdraw(cohost, publishedEn.publication!.id, true);
      assert.deepEqual(await people.listPublic(), []);
      assert.deepEqual(await profiles.listPublicForExperience("public-product", "ja"), []);
      assert.deepEqual(await profiles.listPublicForExperience("public-product", "en"), []);
      assert.equal(await publications.getPublicProviderMediaAsset(photoId), null);
      const withdrawn = await db.pool.query("SELECT photo_consent_withdrawn_at FROM experience_provider_member_profile_publications WHERE id=$1", [publishedEn.publication!.id]);
      assert.ok(withdrawn.rows[0]?.photo_consent_withdrawn_at);
    } finally { await db.dispose(); }
  });

  it("requires active proxy permission plus version-specific consent and separate Admin verification", async () => {
    const db = await createIsolatedDatabase(databaseUrl, "member_profile_proxy");
    try {
      const { people, profiles, member, photo, list } = await fixture(db.pool);
      const ref = await member("member-owner", "OWNER");
      const adminId = ADMIN.nihoUserId;
      const verifier = "adm_synthetic_verifier";
      await list(ref, "proxy-person");
      await assert.rejects(profiles.save(ref, draft("代理入力"), adminId), StoreAccessDeniedError);
      await profiles.setProxyPermission(ref, true, { id: adminId, method: "ORAL" });
      const saved = await profiles.save(ref, draft("代理入力"), adminId);
      assert.equal(saved.proxyPermission?.grantedBy, adminId);
      assert.equal(saved.draft?.updatedBy.id, adminId);
      const attached = await photo(ref, saved.draft!.version, adminId);
      const version = attached.draft!.version;
      assert.equal(await people.getPublicBySlug("proxy-person"), null);
      await assert.rejects(profiles.publish(ref, version, true, verifier), StoreValidationError);
      await assert.rejects(profiles.recordConsent(ref, version, adminId, "WRITTEN", false), StoreValidationError);
      await profiles.recordConsent(ref, version, adminId, "WRITTEN", true);
      assert.equal(await people.getPublicBySlug("proxy-person"), null);
      const edited = await profiles.save(ref, { ...draft("更新した紹介"), photo: attached.draft!.photo, expectedVersion: version }, adminId);
      await assert.rejects(profiles.publish(ref, version, true, verifier), StoreConflictError);
      await assert.rejects(profiles.publish(ref, edited.draft!.version, true, verifier), StoreValidationError);
      await profiles.recordConsent(ref, edited.draft!.version, adminId, "WRITTEN", true);
      await assert.rejects(profiles.publish(ref, edited.draft!.version, false, verifier), StoreValidationError);
      await profiles.publish(ref, edited.draft!.version, true, verifier);
      assert.equal((await people.getPublicBySlug("proxy-person"))?.name, "更新した紹介");
      const recorded = await db.pool.query("SELECT consent_method,consent_recorded_by,verified_by_admin,photo_consented_at,verified_at FROM experience_provider_member_profile_publications");
      assert.equal(recorded.rows[0]?.consent_method, "WRITTEN");
      assert.equal(recorded.rows[0]?.consent_recorded_by, adminId);
      assert.equal(recorded.rows[0]?.verified_by_admin, verifier);
      assert.ok(recorded.rows[0]?.photo_consented_at && recorded.rows[0]?.verified_at);
      await profiles.setProxyPermission(ref, false);
      assert.equal((await profiles.getAsAdmin(ref)).draft, null);
      await assert.rejects(profiles.recordConsent(ref, edited.draft!.version, adminId, "WRITTEN", true), StoreAccessDeniedError);
      await assert.rejects(profiles.save(ref, { ...draft("禁止"), expectedVersion: edited.draft!.version }, adminId), StoreAccessDeniedError);
      assert.equal((await people.getPublicBySlug("proxy-person"))?.name, "更新した紹介");
    } finally { await db.dispose(); }
  });

  it("copies an unassigned legacy listing into a draft when the member is attached", async () => {
    const db = await createIsolatedDatabase(databaseUrl, "member_profile_legacy");
    try {
      const { providerId, people, profiles, member } = await fixture(db.pool);
      const ref = await member("member-owner", "OWNER");
      const id = "plg_00000000000000000000000000000011";
      await db.pool.query(
        `INSERT INTO experience_people_listings (id,provider_id,slug,name_ja,area_ja,role_ja,intro_ja,sort_order,updated_by_admin_niho_user_id)
         VALUES ($1,$2,'legacy-person','既存の名前','鎌倉','職人','既存の原稿',10,'adm_original')`,
        [id, providerId],
      );
      await people.adminSave(ADMIN.nihoUserId, id, 1, ref, { slug: "legacy-person", sortOrder: 10 });
      const state = await profiles.get(ref);
      assert.equal(state.draft?.name, "既存の名前");
      assert.equal(state.draft?.updatedBy.id, "adm_original");
      assert.equal(state.publication, null);
      assert.equal(state.proxyPermission, null);
      assert.equal(await people.getPublicBySlug("legacy-person"), null);
    } finally { await db.dispose(); }
  });
});

it("migration 0090 keeps legacy content and the first three identifiable links without granting consent", { skip: databaseUrl === undefined }, async () => {
  const db = await createIsolatedDatabase(databaseUrl, "member_profile_migration");
  try {
    const { readFile } = await import("node:fs/promises");
    const { providerId, profiles, member, product } = await fixture(db.pool);
    await product("migration-product", false);
    // Remove only the empty tables added in 0090 so the migration runs with legacy rows in place.
    await db.pool.query(`DROP TABLE experience_product_member_profiles,experience_provider_member_proxy_permissions,
      experience_provider_member_profile_publications,experience_provider_member_profiles`);
    const originalIds = ["member-one", "member-two", "member-three", "member-four"];
    const refs = await Promise.all(originalIds.map((id) => member(id, "OWNER")));
    for (const [order, memberId] of [...originalIds, null].entries()) {
      const id = `plg_${String(order + 1).padStart(32, "0")}`;
      await db.pool.query(
        `INSERT INTO experience_people_listings (id,provider_id,member_id,slug,name_ja,role_ja,area_ja,intro_ja,sort_order,updated_by_admin_niho_user_id)
         VALUES ($1,$2,$3,$4,$5,'職人','長谷','旧版の紹介文',$6,'adm_original')`,
        [id, providerId, memberId, `migration-person-${order}`, `旧版の名前 ${order}`, memberId === null ? 0 : (order + 1) * 10],
      );
      await db.pool.query("INSERT INTO experience_people_listing_experiences (listing_id,product_provider_id,product_id,sort_order) VALUES ($1,$2,'migration-product',0)", [id, providerId]);
    }
    await db.pool.query(await readFile(new URL("../migrations/0090_member_profiles.sql", import.meta.url), "utf8"));
    const state = await profiles.get(refs[0]!);
    assert.equal(state.draft?.name, "旧版の名前 0");
    assert.equal(state.draft?.ja.intro, "旧版の紹介文");
    assert.equal(state.draft?.updatedBy.id, "adm_original");
    assert.equal(state.publication, null);
    assert.equal(state.proxyPermission, null);
    assert.deepEqual((await profiles.getProductSelection(refs[0]!, "migration-product")).selected.map(({ memberId }) => memberId), originalIds.slice(0, 3));
    const unassigned = await db.pool.query("SELECT name_ja FROM experience_people_listings WHERE member_id IS NULL");
    assert.equal(unassigned.rows[0]?.name_ja, "旧版の名前 4");
  } finally { await db.dispose(); }
});
