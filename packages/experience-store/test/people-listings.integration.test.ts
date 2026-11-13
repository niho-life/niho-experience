import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { StoreConflictError, StoreNotFoundError, StoreValidationError } from "../src/errors.ts";
import { ExperiencePublicationRepository } from "../src/experience-publication.ts";
import { PeopleListingRepository, validatePeopleListingInput } from "../src/people-listings.ts";
import { createIsolatedDatabase } from "./helpers/isolated-database.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
const ADMIN = { nihoUserId: "adm_synthetic_people" } as const;
const CONSENT = "provider-public-profile-v1";
const input = (slug: string, over: Record<string, unknown> = {}) => ({
  slug, roleJa: "合成の職人", areaJa: "合成の町", quoteJa: "合成のひとこと", introJa: "合成の紹介文です。", sortOrder: 100, ...over,
});

describe("街の人 listings (#564)", { skip: databaseUrl === undefined ? "TEST_DATABASE_URL is not set" : false }, () => {
  it("shows a listed person only while the public profile and a rights-confirmed photo stand, and takes them off when the photo is withdrawn", async () => {
    const db = await createIsolatedDatabase(databaseUrl, "people_listings");
    try {
      const publications = new ExperiencePublicationRepository(db.pool);
      const people = new PeopleListingRepository(db.pool);
      const withPhoto = async (name: string) => {
        const provider = await publications.createAdminProvider(ADMIN, { publicDisplayName: name, providerKind: "PERSON", consentVersion: CONSENT });
        const assetId = randomUUID();
        await publications.addProviderMediaAsAdmin(ADMIN, provider.providerId, 1, CONSENT, {
          id: assetId, objectKey: `experience-provider-media/${assetId}.jpg`, sourceRefHash: "b".repeat(64), width: 800, height: 800, byteSize: 4096,
          placement: "PROVIDER_PHOTO", altText: `${name} photo`, altTextJa: `${name}の写真`, publicCredit: "合成の撮影者",
        });
        return { providerId: provider.providerId, assetId };
      };
      const a = await withPhoto("Synthetic Person A");
      const b = await withPhoto("Synthetic Person B");
      const noPhoto = await publications.createAdminProvider(ADMIN, { publicDisplayName: "Synthetic No Photo", providerKind: "PERSON", consentVersion: CONSENT });

      // Nothing is public before anyone is listed.
      assert.deepEqual(await people.listPublic(), []);
      assert.equal((await people.adminList()).length, 3);

      await people.adminSave(ADMIN.nihoUserId, a.providerId, null, input("person-a", { sortOrder: 20 }));
      await people.adminSave(ADMIN.nihoUserId, b.providerId, null, input("person-b", { sortOrder: 10, quoteJa: null, introJa: null }));
      // Listed without a photo: kept in the Admin list, never public.
      await people.adminSave(ADMIN.nihoUserId, noPhoto.providerId, null, input("person-c"));

      const listed = await people.listPublic();
      assert.deepEqual(listed.map((person) => person.slug), ["person-b", "person-a"]);
      assert.equal(listed[1]?.name, "Synthetic Person A");
      assert.equal(listed[1]?.introJa, "合成の紹介文です。");
      assert.equal(listed[1]?.photo.src, `/api/public/experience-provider-media/${a.assetId}`);
      assert.equal(listed[1]?.photo.credit, "合成の撮影者");
      assert.deepEqual(listed[1]?.experienceSlugs, []);
      assert.equal(listed[0]?.introJa, null);
      assert.equal(await people.getPublicBySlug("person-c"), null);
      assert.equal((await people.getPublicBySlug("person-a"))?.name, "Synthetic Person A");
      assert.equal(await people.getPublicBySlug("Person_A!"), null);

      const admin = await people.adminList();
      assert.deepEqual(admin.filter((row) => row.visible).map((row) => row.listing?.slug), ["person-b", "person-a"]);
      assert.equal(admin.find((row) => row.providerId === noPhoto.providerId)?.photoReady, false);

      // The listing's introduction wins; without one the provider's own bio is shown.
      await db.pool.query(
        `INSERT INTO provider_memberships (provider_id,niho_user_id,role,active) VALUES ($1,'user-bio-owner','OWNER',true)`, [b.providerId],
      );
      await db.pool.query(
        `INSERT INTO provider_host_bios (provider_id,bio_ja,consent_version,consented_at,consented_by_niho_user_id)
         VALUES ($1,'本人が書いた紹介です。','host-bio-consent-v1',clock_timestamp(),'user-bio-owner')`, [b.providerId],
      );
      assert.equal((await people.getPublicBySlug("person-b"))?.introJa, "本人が書いた紹介です。");

      // The photo is public for a listed person even without an experience, and stops being public with the listing.
      assert.ok(await publications.getPublicProviderMediaAsset(a.assetId));
      assert.equal(await publications.getPublicProviderMediaAsset(randomUUID()), null);

      // The slug is unique, a stale version is refused, and the page changes with the row.
      await assert.rejects(people.adminSave(ADMIN.nihoUserId, b.providerId, 1, input("person-a")), (error: unknown) => error instanceof StoreConflictError);
      await assert.rejects(people.adminSave(ADMIN.nihoUserId, a.providerId, 7, input("person-a")), (error: unknown) => error instanceof StoreConflictError);
      await assert.rejects(people.adminSave(ADMIN.nihoUserId, a.providerId, null, input("person-a")), (error: unknown) => error instanceof StoreConflictError);
      await people.adminSave(ADMIN.nihoUserId, a.providerId, 1, input("person-a", { roleJa: "合成の職人（変更後）" }));
      assert.equal((await people.getPublicBySlug("person-a"))?.roleJa, "合成の職人（変更後）");
      await assert.rejects(people.adminSave(ADMIN.nihoUserId, "prv_00000000000000000000000000000000", null, input("nobody")), (error: unknown) => error instanceof StoreNotFoundError);

      // Withdrawing a photo's permission takes the person off every page and the photo off the public route.
      await publications.revokeProviderMediaAsAdmin(ADMIN, a.providerId, a.assetId, 2);
      assert.deepEqual((await people.listPublic()).map((person) => person.slug), ["person-b"]);
      assert.equal(await people.getPublicBySlug("person-a"), null);
      assert.equal(await publications.getPublicProviderMediaAsset(a.assetId), null);
      assert.equal((await people.adminList()).find((row) => row.providerId === a.providerId)?.visible, false);

      // Withdrawing a listing deletes the row (and needs the version the Admin saw).
      await assert.rejects(people.adminWithdraw(ADMIN.nihoUserId, b.providerId, 5), (error: unknown) => error instanceof StoreConflictError);
      await people.adminWithdraw(ADMIN.nihoUserId, b.providerId, 1);
      assert.deepEqual(await people.listPublic(), []);
      assert.equal(await publications.getPublicProviderMediaAsset(b.assetId), null);
      assert.equal(new Map(await people.personForExperiences(["no-such-experience"])).size, 0);
      assert.equal((await people.personForExperiences([])).size, 0);
    } finally {
      await db.dispose();
    }
  });

  it("links a person to other providers' experiences: public ones only, replaced as a whole, and seen from the experience (#585)", async () => {
    const db = await createIsolatedDatabase(databaseUrl, "people_listing_experiences");
    try {
      const pool = db.pool;
      const publications = new ExperiencePublicationRepository(pool);
      const people = new PeopleListingRepository(pool);
      const person = async (name: string, kind: "PERSON" | "BUSINESS" = "PERSON") => {
        const provider = await publications.createAdminProvider(ADMIN, { publicDisplayName: name, providerKind: kind, consentVersion: CONSENT });
        await pool.query("INSERT INTO provider_memberships (provider_id,niho_user_id,role,active) VALUES ($1,'owner','OWNER',true)", [provider.providerId]);
        const assetId = randomUUID();
        await publications.addProviderMediaAsAdmin(ADMIN, provider.providerId, 1, CONSENT, {
          id: assetId, objectKey: `experience-provider-media/${assetId}.jpg`, sourceRefHash: "b".repeat(64), width: 800, height: 800, byteSize: 4096,
          placement: "PROVIDER_PHOTO", altText: `${name} photo`, altTextJa: `${name}の写真`, publicCredit: null,
        });
        return provider.providerId;
      };
      const publish = async (providerId: string, slug: string, status: "PUBLISHED" | "DRAFT" | "ARCHIVED" = "PUBLISHED", live = true) => {
        await pool.query(
          `INSERT INTO experience_products (provider_id,id,slug,status,public_title,currency,unit_amount,cancellation_terms_ref,seller_niho_account_ref,stripe_connect_account_ref,seller_display_name)
           VALUES ($1,$2,$2,$3,$4,'JPY',5000,'terms','seller','acct_x','Seller')`, [providerId, slug, status, `体験 ${slug}`],
        );
        if (!live) return;
        const publication = await pool.query<{ id: string }>(
          `INSERT INTO experience_product_publications (provider_id,product_id,draft_version,slug,public_title,content,currency,unit_amount,cancellation_terms_ref,
             seller_niho_account_ref,stripe_connect_account_ref,seller_display_name,consent_version,published_by_niho_user_id)
           VALUES ($1,$2,1,$2,$3,'{}','JPY',5000,'terms','seller','acct_x','Seller','consent-v1','owner') RETURNING id::text`, [providerId, slug, `体験 ${slug}`],
        );
        await pool.query("INSERT INTO experience_product_publication_states (provider_id,product_id,current_publication_id,first_published_at) VALUES ($1,$2,$3::bigint,clock_timestamp())", [providerId, slug, publication.rows[0]!.id]);
      };
      const sugaProvider = await person("菅 倫明");
      const takuyaProvider = await person("高浜 拓也");
      const zenKarate = await person("ZEN KARATE", "BUSINESS");
      await publish(zenKarate, "zen-karate");
      await publish(zenKarate, "zen-karate-draft", "DRAFT", false);
      await publish(zenKarate, "zen-karate-gone", "PUBLISHED", false);
      await publish(sugaProvider, "suga-own");
      await publish(takuyaProvider, "dinner");
      await people.adminSave(ADMIN.nihoUserId, sugaProvider, null, input("suga", { sortOrder: 10 }));
      await people.adminSave(ADMIN.nihoUserId, takuyaProvider, null, input("takuya", { sortOrder: 20 }));
      const ref = (providerId: string, productId: string) => ({ providerId, productId });

      // Before any link a person shows only their own provider's experiences.
      assert.deepEqual((await people.getPublicBySlug("suga"))?.experienceSlugs, ["suga-own"]);
      assert.deepEqual((await people.getPublicBySlug("takuya"))?.experienceSlugs, ["dinner"]);

      // Another provider's products can be pointed at, in the order given. A product that is only a draft or was never
      // published is linked but not shown; a left-out `experiences` leaves the links as they are.
      await people.adminSave(ADMIN.nihoUserId, sugaProvider, 1, input("suga", { sortOrder: 10, experiences: [ref(zenKarate, "zen-karate"), ref(zenKarate, "zen-karate-draft"), ref(zenKarate, "zen-karate-gone")] }));
      assert.deepEqual((await people.getPublicBySlug("suga"))?.experienceSlugs.slice().sort(), ["suga-own", "zen-karate"]);
      const row = (await people.adminList()).find((item) => item.providerId === sugaProvider)?.listing;
      assert.deepEqual(row?.experiences.map((link) => [link.slug, link.status, link.title]), [["zen-karate", "PUBLISHED", "体験 zen-karate"], ["zen-karate-draft", "DRAFT", "体験 zen-karate-draft"], ["zen-karate-gone", "PUBLISHED", "体験 zen-karate-gone"]]);
      await people.adminSave(ADMIN.nihoUserId, sugaProvider, 2, input("suga", { sortOrder: 10, roleJa: "空手指導者" }));
      assert.equal((await people.adminList()).find((item) => item.providerId === sugaProvider)?.listing?.experiences.length, 3);

      // Several people can share one experience; the experience sees them in the Admin's order, and an unlisted provider's experience has none.
      await people.adminSave(ADMIN.nihoUserId, takuyaProvider, 1, input("takuya", { sortOrder: 20, experiences: [ref(zenKarate, "zen-karate")] }));
      const seen = await people.personForExperiences(["zen-karate", "suga-own", "dinner", "zen-karate-draft", "nope"]);
      assert.deepEqual(seen.get("zen-karate")?.map((p) => p.slug), ["suga", "takuya"]);
      assert.deepEqual(seen.get("suga-own")?.map((p) => p.slug), ["suga"]);
      assert.deepEqual(seen.get("dinner")?.map((p) => p.slug), ["takuya"]);
      assert.equal(seen.has("zen-karate-draft"), false);
      assert.equal(seen.has("nope"), false);

      // A stopped product leaves the person's page and the experience's people at once.
      await pool.query("UPDATE experience_product_publication_states SET self_stopped_at=clock_timestamp() WHERE product_id='zen-karate'");
      assert.deepEqual((await people.getPublicBySlug("suga"))?.experienceSlugs, ["suga-own"]);
      assert.equal((await people.personForExperiences(["zen-karate"])).has("zen-karate"), false);
      await pool.query("UPDATE experience_product_publication_states SET self_stopped_at=NULL WHERE product_id='zen-karate'");
      assert.equal((await people.getPublicBySlug("suga"))?.experienceSlugs.includes("zen-karate"), true);

      // Replaced as a whole; an empty list clears; a product that does not exist or is archived, a repeat and too many are refused.
      await people.adminSave(ADMIN.nihoUserId, sugaProvider, 3, input("suga", { sortOrder: 10, roleJa: "空手指導者", experiences: [] }));
      assert.deepEqual((await people.getPublicBySlug("suga"))?.experienceSlugs, ["suga-own"]);
      await publish(zenKarate, "zen-karate-old", "ARCHIVED", false);
      for (const bad of [[ref(zenKarate, "no-such")], [ref(zenKarate, "zen-karate-old")]]) {
        await assert.rejects(people.adminSave(ADMIN.nihoUserId, sugaProvider, 4, input("suga", { sortOrder: 10, roleJa: "空手指導者", experiences: bad })), StoreNotFoundError);
      }
      for (const bad of [[ref(zenKarate, "zen-karate"), ref(zenKarate, "zen-karate")], [{ providerId: zenKarate }], "zen-karate", Array.from({ length: 51 }, (_, i) => ref(zenKarate, `p${i}`))]) {
        await assert.rejects(people.adminSave(ADMIN.nihoUserId, sugaProvider, 4, input("suga", { sortOrder: 10, roleJa: "空手指導者", experiences: bad as never })), StoreValidationError);
      }
      // A failed save changes nothing (the links were cleared above and are still empty).
      assert.deepEqual((await people.getPublicBySlug("suga"))?.experienceSlugs, ["suga-own"]);

      // Withdrawing the person takes their links with them.
      await people.adminSave(ADMIN.nihoUserId, takuyaProvider, 2, input("takuya", { sortOrder: 20, experiences: [ref(zenKarate, "zen-karate")] }));
      const version = (await people.adminList()).find((item) => item.providerId === takuyaProvider)?.listing?.version as number;
      await people.adminWithdraw(ADMIN.nihoUserId, takuyaProvider, version);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM experience_people_listing_experiences")).rows[0]?.n, 0);
    } finally {
      await db.dispose();
    }
  });

  it("checks what the Admin typed the way the table does", () => {
    const ok = validatePeopleListingInput(input("kintsugi-2"));
    assert.equal(ok.slug, "kintsugi-2");
    for (const bad of [
      input("A"), input("a"), input("Has Space"), input("double--hyphen"), input("-lead"), input("x".repeat(61)),
      input("ok-slug", { roleJa: "" }), input("ok-slug", { roleJa: " padded " }), input("ok-slug", { areaJa: "あ".repeat(41) }),
      input("ok-slug", { quoteJa: "改行\nあり" }), input("ok-slug", { introJa: "あ".repeat(1201) }),
      input("ok-slug", { sortOrder: -1 }), input("ok-slug", { sortOrder: 1.5 }), input("ok-slug", { introJa: "制御\u0007文字" }),
    ]) {
      assert.throws(() => validatePeopleListingInput(bad as never), (error: unknown) => error instanceof StoreValidationError, JSON.stringify(bad).slice(0, 80));
    }
    assert.equal(validatePeopleListingInput(input("ok-slug", { introJa: "一行目\r\n\r\n\r\n\r\n二行目 " })).introJa, "一行目\n\n二行目");
    assert.equal(validatePeopleListingInput(input("ok-slug", { quoteJa: "" })).quoteJa, null);
  });
});
