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
