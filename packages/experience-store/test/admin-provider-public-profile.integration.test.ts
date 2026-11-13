import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { StoreConflictError, StoreNotFoundError } from "../src/errors.ts";
import { ExperiencePublicationRepository } from "../src/experience-publication.ts";
import { createIsolatedDatabase } from "./helpers/isolated-database.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
const ADMIN = { nihoUserId: "adm_synthetic_provider_identity" } as const;

describe("Admin provider public identity persistence (#507 #378)", { skip: databaseUrl === undefined ? "TEST_DATABASE_URL is not set" : false }, () => {
  it("records consent without creating seller or membership state and keeps media provider-scoped", async () => {
    const db = await createIsolatedDatabase(databaseUrl, "admin_provider_public_identity");
    try {
      const repository = new ExperiencePublicationRepository(db.pool);
      const profile = await repository.createAdminProvider(ADMIN, {
        publicDisplayName: "Synthetic Actual Host",
        providerKind: "PERSON",
        consentVersion: "provider-public-profile-v1",
      });
      assert.match(profile.providerId, /^prv_[0-9a-f]{32}$/);
      assert.equal(profile.publicDisplayName, "Synthetic Actual Host");
      assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM provider_memberships WHERE provider_id=$1", [profile.providerId])).rows[0]?.n, 0);
      assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM experience_host_seller_profiles WHERE provider_id=$1", [profile.providerId])).rows[0]?.n, 0);
      const stored = (await db.pool.query(
        "SELECT consented_by_admin_niho_user_id FROM experience_provider_public_profiles WHERE provider_id=$1",
        [profile.providerId],
      )).rows[0];
      assert.equal(stored?.consented_by_admin_niho_user_id, ADMIN.nihoUserId);

      const assetId = randomUUID();
      const media = await repository.addProviderMediaAsAdmin(ADMIN, profile.providerId, 1, "provider-public-profile-v1", {
        id: assetId,
        objectKey: `experience-provider-media/${assetId}.jpg`,
        sourceRefHash: "a".repeat(64),
        width: 800,
        height: 800,
        byteSize: 4096,
        placement: "PROVIDER_PHOTO",
        altText: "Synthetic actual host",
        altTextJa: "合成の実提供者",
        publicCredit: null,
      });
      assert.equal(media.assets[0]?.id, assetId);
      const assetConsent = (await db.pool.query(
        "SELECT rights_confirmed_by_admin_niho_user_id,rights_consent_version FROM experience_provider_media_assets WHERE id=$1",
        [assetId],
      )).rows[0];
      assert.deepEqual(assetConsent, {
        rights_confirmed_by_admin_niho_user_id: ADMIN.nihoUserId,
        rights_consent_version: "provider-public-profile-v1",
      });

      const other = await repository.createAdminProvider(ADMIN, {
        publicDisplayName: "Other Synthetic Host",
        providerKind: null,
        consentVersion: "provider-public-profile-v1",
      });
      await assert.rejects(
        repository.revokeProviderMediaAsAdmin(ADMIN, other.providerId, assetId, 1),
        (error: unknown) => error instanceof StoreNotFoundError,
      );
      await assert.rejects(
        repository.saveAdminProviderPublicProfile(ADMIN, profile.providerId, 99, {
          publicDisplayName: "Stale Update",
          providerKind: "PERSON",
          consentVersion: "provider-public-profile-v1",
        }),
        (error: unknown) => error instanceof StoreConflictError,
      );
      assert.equal((await repository.getAdminProviderMedia(ADMIN, profile.providerId)).assets[0]?.id, assetId);
    } finally {
      await db.dispose();
    }
  });

  it("adds a consented public identity to an existing provider without inferring seller readiness", async () => {
    const db = await createIsolatedDatabase(databaseUrl, "existing_provider_public_identity");
    try {
      await db.pool.query("INSERT INTO experience_providers (id) VALUES ('provider-existing')");
      const repository = new ExperiencePublicationRepository(db.pool);
      const saved = await repository.saveAdminProviderPublicProfile(ADMIN, "provider-existing", null, {
        publicDisplayName: "Existing Actual Host",
        providerKind: "BUSINESS",
        consentVersion: "provider-public-profile-v1",
      });
      assert.equal(saved.publicDisplayName, "Existing Actual Host");
      const current = await repository.getAdminProvider(ADMIN, "provider-existing");
      assert.equal(current.profile?.providerKind, "BUSINESS");
      assert.equal(current.provider.sellerDisplayName, null);
      assert.equal((await repository.getAdminProviderMedia(ADMIN, "provider-existing")).version, 1);
    } finally {
      await db.dispose();
    }
  });

  it("keeps an optional English public name: set on create, kept when not sent, cleared with null, rejected when malformed (#587)", async () => {
    const db = await createIsolatedDatabase(databaseUrl, "provider_public_name_en");
    try {
      const repository = new ExperiencePublicationRepository(db.pool);
      const consentVersion = "provider-public-profile-v1";
      const created = await repository.createAdminProvider(ADMIN, { publicDisplayName: "合成の志龍", providerKind: "PERSON", consentVersion, publicDisplayNameEn: "Synthetic Shiryu" });
      assert.equal(created.publicDisplayNameEn, "Synthetic Shiryu");
      const plain = await repository.createAdminProvider(ADMIN, { publicDisplayName: "合成の人", providerKind: "PERSON", consentVersion });
      assert.equal(plain.publicDisplayNameEn, null);
      assert.equal((await repository.listAdminProviders(ADMIN)).find((p) => p.providerId === created.providerId)?.publicDisplayNameEn, "Synthetic Shiryu");

      // Not sent → unchanged (the Japanese name can be edited on its own).
      const renamed = await repository.saveAdminProviderPublicProfile(ADMIN, created.providerId, 1, { publicDisplayName: "合成の志龍2", providerKind: "PERSON", consentVersion });
      assert.equal(renamed.publicDisplayName, "合成の志龍2");
      assert.equal(renamed.publicDisplayNameEn, "Synthetic Shiryu");
      // Sent → replaced; null or "" → cleared (the public pages fall back to the Japanese name).
      const changed = await repository.saveAdminProviderPublicProfile(ADMIN, created.providerId, 2, { publicDisplayName: "合成の志龍2", providerKind: "PERSON", consentVersion, publicDisplayNameEn: "Synthetic S." });
      assert.equal(changed.publicDisplayNameEn, "Synthetic S.");
      const cleared = await repository.saveAdminProviderPublicProfile(ADMIN, created.providerId, 3, { publicDisplayName: "合成の志龍2", providerKind: "PERSON", consentVersion, publicDisplayNameEn: null });
      assert.equal(cleared.publicDisplayNameEn, null);
      assert.equal((await db.pool.query("SELECT public_display_name_en FROM experience_provider_public_profiles WHERE provider_id=$1", [created.providerId])).rows[0]?.public_display_name_en, null);

      // The same character rules as the Japanese name hold at the database too.
      for (const bad of [" lead", "trail ", "tab\there", "x".repeat(301)]) {
        await assert.rejects(repository.saveAdminProviderPublicProfile(ADMIN, created.providerId, 4, { publicDisplayName: "合成の志龍2", providerKind: "PERSON", consentVersion, publicDisplayNameEn: bad }));
      }
      await assert.rejects(db.pool.query("UPDATE experience_provider_public_profiles SET public_display_name_en='' WHERE provider_id=$1", [created.providerId]));
    } finally {
      await db.dispose();
    }
  });
});
