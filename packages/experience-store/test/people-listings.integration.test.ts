import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import type { Pool } from "pg";
import { StoreConflictError, StoreNotFoundError, StoreValidationError } from "../src/errors.ts";
import { ExperiencePublicationRepository } from "../src/experience-publication.ts";
import { PeopleListingRepository, validatePeopleListingInput, type PeopleListingInput } from "../src/people-listings.ts";
import { createIsolatedDatabase } from "./helpers/isolated-database.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
const ADMIN = { nihoUserId: "adm_synthetic_people" } as const;
const CONSENT = "provider-public-profile-v1";
const input = (slug: string, over: Record<string, unknown> = {}): PeopleListingInput => ({
  slug, nameJa: `名前 ${slug}`, roleJa: "合成の職人", areaJa: "合成の町", quoteJa: "合成のひとこと", introJa: "合成の紹介文です。", sortOrder: 100, ...over,
} as PeopleListingInput);

/** Providers, photos, members and saves for these cases. */
function fixtures(pool: Pool) {
  const publications = new ExperiencePublicationRepository(pool);
  const people = new PeopleListingRepository(pool);
  const provider = async (name: string, kind: "PERSON" | "BUSINESS" = "BUSINESS", photo = true): Promise<{ providerId: string; assetId: string | null }> => {
    const created = await publications.createAdminProvider(ADMIN, { publicDisplayName: name, providerKind: kind, consentVersion: CONSENT });
    if (!photo) return { providerId: created.providerId, assetId: null };
    const assetId = randomUUID();
    await publications.addProviderMediaAsAdmin(ADMIN, created.providerId, 1, CONSENT, {
      id: assetId, objectKey: `experience-provider-media/${assetId}.jpg`, sourceRefHash: "b".repeat(64), width: 800, height: 800, byteSize: 4096,
      placement: "PROVIDER_PHOTO", altText: `${name} photo`, altTextJa: `${name}の写真`, publicCredit: "合成の撮影者",
    });
    return { providerId: created.providerId, assetId };
  };
  const member = (providerId: string, memberId: string, role: "OWNER" | "COHOST" | "EDITOR" | "VIEWER" = "OWNER", active = true) =>
    pool.query("INSERT INTO provider_memberships (provider_id,niho_user_id,role,active) VALUES ($1,$2,$3,$4)", [providerId, memberId, role, active]);
  const create = (providerId: string, memberId: string | null, slug: string, over: Record<string, unknown> = {}) =>
    people.adminSave(ADMIN.nihoUserId, null, null, { providerId, memberId }, input(slug, over));
  const row = async (slug: string) => (await people.adminList()).find((item) => item.listing?.slug === slug)!;
  const update = async (slug: string, target: { providerId: string; memberId: string | null }, over: Record<string, unknown> = {}) => {
    const current = (await row(slug)).listing!;
    return people.adminSave(ADMIN.nihoUserId, current.id, current.version, target, input(slug, over));
  };
  return { publications, people, provider, member, create, row, update };
}

describe("街の人 listings (#564, #589)", { skip: databaseUrl === undefined ? "TEST_DATABASE_URL is not set" : false }, () => {
  it("lists people of a provider (several per provider), shows them while their membership and photo stand, and says why not otherwise", async () => {
    const db = await createIsolatedDatabase(databaseUrl, "people_listings");
    try {
      const { publications, people, provider, member, create, row, update } = fixtures(db.pool);
      const business = await provider("Synthetic Business");
      const other = await provider("Synthetic Other");
      await member(business.providerId, "member-a", "OWNER");
      await member(business.providerId, "member-b", "COHOST");
      await member(business.providerId, "member-editor", "EDITOR");
      await member(business.providerId, "member-gone", "COHOST", false);
      await member(other.providerId, "member-o", "OWNER");

      // Nothing is public before anyone is listed; the Admin sees the members who could be listed (OWNER and co-host, current).
      assert.deepEqual(await people.listPublic(), []);
      const before = await people.adminList();
      assert.deepEqual(before.map((item) => [item.memberId, item.memberRole, item.listing, item.key.startsWith("new:")]).sort(), [
        ["member-a", "OWNER", null, true], ["member-b", "COHOST", null, true], ["member-o", "OWNER", null, true],
      ]);

      // Two people of one provider; the second has a photo of her own (another provider's asset), the first takes the provider's.
      const hers = await provider("Synthetic Photographer", "PERSON");
      await create(business.providerId, "member-a", "person-a", { sortOrder: 20 });
      await create(business.providerId, "member-b", "person-b", { sortOrder: 10, quoteJa: null, introJa: null, photo: { assetId: hers.assetId, altJa: "彼女の写真", credit: null } });
      // A draft that waits for the person's account, and one whose member is the provider's but not a responder.
      await create(other.providerId, null, "person-draft");
      await assert.rejects(create(business.providerId, "member-editor", "person-editor"), StoreValidationError);
      await assert.rejects(create(business.providerId, "member-gone", "person-gone"), StoreValidationError);
      await assert.rejects(create(business.providerId, "not-a-member", "person-stranger"), StoreValidationError);
      // A provider's member listed twice, and a slug twice, are conflicts.
      await assert.rejects(create(business.providerId, "member-a", "person-a-again"), StoreConflictError);
      await assert.rejects(create(other.providerId, "member-o", "person-a"), StoreConflictError);

      const listed = await people.listPublic();
      assert.deepEqual(listed.map((person) => person.slug), ["person-b", "person-a"]);
      assert.equal(listed[1]?.name, "名前 person-a");
      assert.equal(listed[1]?.introJa, "合成の紹介文です。");
      assert.equal(listed[1]?.photo.src, `/api/public/experience-provider-media/${business.assetId}`);
      assert.equal(listed[1]?.photo.credit, "合成の撮影者");
      assert.equal(listed[1]?.photo.altJa, "Synthetic Businessの写真");
      assert.deepEqual(listed[1]?.experienceSlugs, []);
      assert.equal(listed[0]?.photo.src, `/api/public/experience-provider-media/${hers.assetId}`);
      assert.equal(listed[0]?.photo.altJa, "彼女の写真");
      assert.equal(listed[0]?.photo.credit, null);
      assert.equal(listed[0]?.quoteJa, null);
      assert.equal(listed[0]?.introJa, null);
      assert.equal(await people.getPublicBySlug("person-draft"), null);
      assert.equal((await people.getPublicBySlug("person-a"))?.name, "名前 person-a");
      assert.equal(await people.getPublicBySlug("Person_A!"), null);

      const admin = await people.adminList();
      assert.deepEqual(admin.filter((item) => item.visible).map((item) => item.listing?.slug), ["person-b", "person-a"]);
      assert.equal((await row("person-draft")).memberRole, null);
      assert.equal((await row("person-draft")).visible, false);
      assert.equal((await row("person-draft")).photoReady, true);
      assert.equal((await row("person-a")).providerName, "Synthetic Business");

      // Photos are public through the listing, whichever provider holds the asset; others are not.
      assert.ok(await publications.getPublicProviderMediaAsset(business.assetId!));
      assert.ok(await publications.getPublicProviderMediaAsset(hers.assetId!));
      assert.equal(await publications.getPublicProviderMediaAsset(randomUUID()), null);

      // A stale version is refused, the page changes with the row, and the listing can be moved to another provider and member.
      await assert.rejects(people.adminSave(ADMIN.nihoUserId, (await row("person-a")).listing!.id, 7, { providerId: business.providerId, memberId: "member-a" }, input("person-a")), StoreConflictError);
      await update("person-a", { providerId: business.providerId, memberId: "member-a" }, { roleJa: "合成の職人（変更後）" });
      assert.equal((await people.getPublicBySlug("person-a"))?.roleJa, "合成の職人（変更後）");
      assert.equal((await people.getPublicBySlug("person-a"))?.photo.src, `/api/public/experience-provider-media/${business.assetId}`);
      await assert.rejects(people.adminSave(ADMIN.nihoUserId, null, null, { providerId: "prv_00000000000000000000000000000000", memberId: null }, input("nobody")), StoreNotFoundError);
      await assert.rejects(people.adminSave(ADMIN.nihoUserId, null, null, { providerId: other.providerId, memberId: null }, input("no-photo", { photo: { assetId: randomUUID(), altJa: "x", credit: null } })), StoreNotFoundError);
      await update("person-draft", { providerId: other.providerId, memberId: "member-o" });
      assert.equal((await people.getPublicBySlug("person-draft"))?.name, "名前 person-draft");
      await update("person-draft", { providerId: other.providerId, memberId: null });
      assert.equal(await people.getPublicBySlug("person-draft"), null);
      // A member of another provider cannot be attached.
      await assert.rejects(update("person-draft", { providerId: other.providerId, memberId: "member-a" }), StoreValidationError);

      // The member stops being OWNER or co-host: the person leaves every page at once. A role that is not a responder is not enough.
      await db.pool.query("UPDATE provider_memberships SET active=false WHERE provider_id=$1 AND niho_user_id='member-b'", [business.providerId]);
      assert.deepEqual((await people.listPublic()).map((person) => person.slug), ["person-a"]);
      assert.equal(await people.getPublicBySlug("person-b"), null);
      assert.equal((await row("person-b")).memberRole, null);
      await db.pool.query("UPDATE provider_memberships SET active=true,role='EDITOR' WHERE provider_id=$1 AND niho_user_id='member-b'", [business.providerId]);
      assert.deepEqual((await people.listPublic()).map((person) => person.slug), ["person-a"]);
      await db.pool.query("UPDATE provider_memberships SET role='COHOST' WHERE provider_id=$1 AND niho_user_id='member-b'", [business.providerId]);
      assert.deepEqual((await people.listPublic()).map((person) => person.slug), ["person-b", "person-a"]);

      // Withdrawing a photo's permission takes that person off every page and the photo off the public route.
      await publications.revokeProviderMediaAsAdmin(ADMIN, hers.providerId, hers.assetId!, 2);
      assert.deepEqual((await people.listPublic()).map((person) => person.slug), ["person-a"]);
      assert.equal(await publications.getPublicProviderMediaAsset(hers.assetId!), null);
      assert.equal((await row("person-b")).visible, false);
      assert.equal((await row("person-b")).photoReady, false);

      // Withdrawing a listing deletes the row (and needs the version the Admin saw); the photo stays with its provider.
      const a = (await row("person-a")).listing!;
      await assert.rejects(people.adminWithdraw(ADMIN.nihoUserId, a.id, a.version + 5), StoreConflictError);
      await people.adminWithdraw(ADMIN.nihoUserId, a.id, a.version);
      assert.deepEqual(await people.listPublic(), []);
      assert.equal((await people.adminList()).some((item) => item.listing?.slug === "person-a"), false);
      assert.equal(new Map(await people.personForExperiences(["no-such-experience"])).size, 0);
      assert.equal((await people.personForExperiences([])).size, 0);
    } finally {
      await db.dispose();
    }
  });

  it("links a person to experiences of any provider: public ones only, replaced as a whole, and seen from the experience (#585)", async () => {
    const db = await createIsolatedDatabase(databaseUrl, "people_listing_experiences");
    try {
      const pool = db.pool;
      const { people, provider, member, create, row, update } = fixtures(pool);
      const publish = async (providerId: string, slug: string, status: "PUBLISHED" | "DRAFT" | "ARCHIVED" = "PUBLISHED", live = true) => {
        await pool.query(
          `INSERT INTO experience_products (provider_id,id,slug,status,public_title,currency,unit_amount,cancellation_terms_ref,seller_niho_account_ref,stripe_connect_account_ref,seller_display_name)
           VALUES ($1,$2,$2,$3,$4,'JPY',5000,'terms','seller','acct_x','Seller')`, [providerId, slug, status, `体験 ${slug}`],
        );
        if (!live) return;
        await pool.query("INSERT INTO provider_memberships (provider_id,niho_user_id,role,active) VALUES ($1,'publisher','VIEWER',true) ON CONFLICT DO NOTHING", [providerId]);
        const publication = await pool.query<{ id: string }>(
          `INSERT INTO experience_product_publications (provider_id,product_id,draft_version,slug,public_title,content,currency,unit_amount,cancellation_terms_ref,
             seller_niho_account_ref,stripe_connect_account_ref,seller_display_name,consent_version,published_by_niho_user_id)
           VALUES ($1,$2,1,$2,$3,'{}','JPY',5000,'terms','seller','acct_x','Seller','consent-v1','publisher') RETURNING id::text`, [providerId, slug, `体験 ${slug}`],
        );
        await pool.query("INSERT INTO experience_product_publication_states (provider_id,product_id,current_publication_id,first_published_at) VALUES ($1,$2,$3::bigint,clock_timestamp())", [providerId, slug, publication.rows[0]!.id]);
      };
      const zenKarate = (await provider("ZEN KARATE")).providerId;
      const kamakura = (await provider("NIHO kamakura")).providerId;
      await member(kamakura, "suga", "OWNER");
      await member(kamakura, "takuya", "COHOST");
      await publish(zenKarate, "zen-karate");
      await publish(zenKarate, "zen-karate-draft", "DRAFT", false);
      await publish(zenKarate, "zen-karate-gone", "PUBLISHED", false);
      await publish(kamakura, "dinner");
      await create(kamakura, "suga", "suga", { sortOrder: 10 });
      await create(kamakura, "takuya", "takuya", { sortOrder: 20 });
      const ref = (providerId: string, productId: string) => ({ providerId, productId });
      const at = { providerId: kamakura };

      // A person shows only the experiences they are linked to: not everything their provider sells.
      assert.deepEqual((await people.getPublicBySlug("suga"))?.experienceSlugs, []);
      assert.deepEqual((await people.getPublicBySlug("takuya"))?.experienceSlugs, []);

      // Products of any provider can be pointed at, in the order given. A product that is only a draft or was never published is linked
      // but not shown; a left-out `experiences` leaves the links as they are.
      await update("suga", { ...at, memberId: "suga" }, { sortOrder: 10, experiences: [ref(zenKarate, "zen-karate"), ref(zenKarate, "zen-karate-draft"), ref(zenKarate, "zen-karate-gone"), ref(kamakura, "dinner")] });
      assert.deepEqual((await people.getPublicBySlug("suga"))?.experienceSlugs.slice().sort(), ["dinner", "zen-karate"]);
      const listing = (await row("suga")).listing;
      assert.deepEqual(listing?.experiences.map((link) => [link.slug, link.status, link.title]), [["zen-karate", "PUBLISHED", "体験 zen-karate"], ["zen-karate-draft", "DRAFT", "体験 zen-karate-draft"], ["zen-karate-gone", "PUBLISHED", "体験 zen-karate-gone"], ["dinner", "PUBLISHED", "体験 dinner"]]);
      await update("suga", { ...at, memberId: "suga" }, { sortOrder: 10, roleJa: "空手指導者" });
      assert.equal((await row("suga")).listing?.experiences.length, 4);

      // Several people can share one experience; the experience sees them in the Admin's order, and an experience nobody is linked to has none.
      await update("takuya", { ...at, memberId: "takuya" }, { sortOrder: 20, experiences: [ref(zenKarate, "zen-karate"), ref(kamakura, "dinner")] });
      const seen = await people.personForExperiences(["zen-karate", "dinner", "zen-karate-draft", "nope"]);
      assert.deepEqual(seen.get("zen-karate")?.map((p) => p.slug), ["suga", "takuya"]);
      assert.deepEqual(seen.get("dinner")?.map((p) => p.slug), ["suga", "takuya"]);
      assert.deepEqual(seen.get("zen-karate")?.map((p) => p.name), ["名前 suga", "名前 takuya"]);
      assert.equal(seen.has("zen-karate-draft"), false);
      assert.equal(seen.has("nope"), false);

      // A person whose membership ended leaves the experience's people, and a stopped product leaves the person's page, at once.
      await pool.query("UPDATE provider_memberships SET active=false WHERE niho_user_id='takuya'");
      assert.deepEqual((await people.personForExperiences(["zen-karate"])).get("zen-karate")?.map((p) => p.slug), ["suga"]);
      await pool.query("UPDATE provider_memberships SET active=true WHERE niho_user_id='takuya'");
      await pool.query("UPDATE experience_product_publication_states SET self_stopped_at=clock_timestamp() WHERE product_id='zen-karate'");
      assert.deepEqual((await people.getPublicBySlug("suga"))?.experienceSlugs, ["dinner"]);
      assert.equal((await people.personForExperiences(["zen-karate"])).has("zen-karate"), false);
      await pool.query("UPDATE experience_product_publication_states SET self_stopped_at=NULL WHERE product_id='zen-karate'");
      assert.equal((await people.getPublicBySlug("suga"))?.experienceSlugs.includes("zen-karate"), true);

      // Replaced as a whole; an empty list clears; a product that does not exist or is archived, a repeat and too many are refused.
      await update("suga", { ...at, memberId: "suga" }, { sortOrder: 10, roleJa: "空手指導者", experiences: [] });
      assert.deepEqual((await people.getPublicBySlug("suga"))?.experienceSlugs, []);
      await publish(zenKarate, "zen-karate-old", "ARCHIVED", false);
      for (const bad of [[ref(zenKarate, "no-such")], [ref(zenKarate, "zen-karate-old")]]) {
        await assert.rejects(update("suga", { ...at, memberId: "suga" }, { sortOrder: 10, roleJa: "空手指導者", experiences: bad }), StoreNotFoundError);
      }
      for (const bad of [[ref(zenKarate, "zen-karate"), ref(zenKarate, "zen-karate")], [{ providerId: zenKarate }], "zen-karate", Array.from({ length: 51 }, (_, i) => ref(zenKarate, `p${i}`))]) {
        await assert.rejects(update("suga", { ...at, memberId: "suga" }, { sortOrder: 10, roleJa: "空手指導者", experiences: bad as never }), StoreValidationError);
      }
      assert.deepEqual((await people.getPublicBySlug("suga"))?.experienceSlugs, []);

      // Withdrawing the person takes their links with them.
      const takuya = (await row("takuya")).listing!;
      await people.adminWithdraw(ADMIN.nihoUserId, takuya.id, takuya.version);
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
      input("ok-slug", { nameJa: "" }), input("ok-slug", { nameJa: "あ".repeat(41) }), input("ok-slug", { nameJa: " padded " }),
      input("ok-slug", { roleJa: "" }), input("ok-slug", { roleJa: " padded " }), input("ok-slug", { areaJa: "あ".repeat(41) }),
      input("ok-slug", { quoteJa: "改行\nあり" }), input("ok-slug", { introJa: "あ".repeat(1201) }),
      input("ok-slug", { sortOrder: -1 }), input("ok-slug", { sortOrder: 1.5 }), input("ok-slug", { introJa: "制御\u0007文字" }),
      input("ok-slug", { photo: { assetId: "not-a-uuid", altJa: "x", credit: null } }),
      input("ok-slug", { photo: { assetId: randomUUID(), altJa: "", credit: null } }),
    ]) {
      assert.throws(() => validatePeopleListingInput(bad as never), (error: unknown) => error instanceof StoreValidationError, JSON.stringify(bad).slice(0, 80));
    }
    assert.equal(validatePeopleListingInput(input("ok-slug", { introJa: "一行目\r\n\r\n\r\n\r\n二行目 " })).introJa, "一行目\n\n二行目");
    assert.equal(validatePeopleListingInput(input("ok-slug", { quoteJa: "" })).quoteJa, null);
    assert.equal(validatePeopleListingInput(input("ok-slug", { photo: null })).photo, null);
  });
});
