import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import type { ScheduleRule } from "@niho-experience/experience-domain";
import { StoreAccessDeniedError } from "../src/errors.ts";
import { ExperiencePublicationBlockedError, ExperiencePublicationRepository } from "../src/experience-publication.ts";
import { HostAccounts } from "../src/host-accounts.ts";
import { ProviderPayoutAccountConsents } from "../src/payout-account-consents.ts";
import { ExperienceStore } from "../src/repository.ts";
import { EXPERIENCE_SUPPORT_CONSENT_VERSION, GuestBookingRepository } from "../src/guest-bookings.ts";
import { createIsolatedDatabase } from "./helpers/isolated-database.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
const publicationConsent = "publication-consent-synthetic-v1";
const payoutConsent = "synthetic-payout-v1";
const stripeAccount = "acct_SyntheticAssisted";

describe("Admin product draft handoff (#169)", { skip: databaseUrl === undefined ? "TEST_DATABASE_URL is not set" : false }, () => {
  for (const kind of ["legacy", "experience"] as const) it(`prepares and publishes a ${kind} seller's draft under the correct actor`, async () => {
    const db = await createIsolatedDatabase(databaseUrl, "admin_product_draft", { max: 4 });
    const pool = db.pool;
    const providerId = "provider-assisted-synthetic";
    const admin = { nihoUserId: "admin-assisted-synthetic" } as const;
    try {
      await pool.query("INSERT INTO experience_providers (id) VALUES ($1)", [providerId]);
      const accounts = new HostAccounts(pool);
      const ownerId = kind === "experience"
        ? (await accounts.provisionHostAccount({ email: "synthetic-owner@example.test", nowUtc: new Date().toISOString() })).hostAccountId
        : "owner-assisted-synthetic";
      const owner = { providerId, nihoUserId: ownerId };
      await pool.query(
        `INSERT INTO experience_host_seller_profiles
           (provider_id,legacy_provider_id,provider_display_name,seller_niho_account_ref,stripe_connect_account_ref,seller_display_name)
         VALUES ($1,$2,'Synthetic craft host',$3,$4,'Synthetic Craft Seller')`,
        [providerId, kind === "experience" ? null : "legacy-assisted-synthetic",
          kind === "experience" ? `sel_${"a".repeat(32)}` : ownerId, stripeAccount],
      );
      await pool.query(
        "INSERT INTO provider_sale_settings (provider_id,support_enabled,platform_fee_basis_points) VALUES ($1,false,1000)",
        [providerId],
      );

      const publications = new ExperiencePublicationRepository(pool);
      const store = new ExperienceStore(pool);
      const sellers = await publications.listAdminDraftSellers(admin);
      assert.deepEqual(sellers, [{ providerId, providerDisplayName: "Synthetic craft host", sellerDisplayName: "Synthetic Craft Seller" }]);
      assert.equal("sellerNihoAccountRef" in sellers[0]!, false);
      assert.equal("stripeConnectAccountRef" in sellers[0]!, false);

      const draft = await publications.createDraftAsAdmin(admin, providerId, {
        slug: "synthetic-assisted-craft",
        publicTitle: "Synthetic assisted craft",
        content: {
          ja: {
            title: "合成の工芸体験", lead: "合成の紹介文", description: "合成の説明文", language: "日本語・英語",
            highlights: ["合成の特徴"], included: ["合成の材料"], notIncluded: [], knowBeforeYouGo: ["合成の注意"],
            notSuitableFor: [], timeline: [],
          },
          lead: "A synthetic lead.", description: "Synthetic draft copy.", facts: { language: "Japanese and English" },
          highlights: ["A synthetic highlight."], included: ["Synthetic materials"], notIncluded: [],
          knowBeforeYouGo: ["Synthetic guidance."], notSuitableFor: [], timeline: [],
          meetingOverview: "Near a synthetic station.", meetingPointDisclosure: "AFTER_BOOKING", meetingPoint: null,
        },
        currency: "JPY",
        unitAmount: 4_000,
      });
      assert.equal((await pool.query("SELECT count(*)::int AS count FROM provider_memberships WHERE provider_id=$1", [providerId])).rows[0]?.count, 0);

      const mediaId = randomUUID();
      const media = await publications.addMediaAsAdmin(admin, providerId, draft.id, {
        id: mediaId,
        objectKey: `experience-products/${mediaId}.jpg`,
        sourceRefHash: "a".repeat(64),
        width: 1200,
        height: 800,
        byteSize: 4096,
        altText: "Synthetic craft materials",
        altTextJa: "合成の工芸材料",
        publicCredit: null,
      });
      assert.equal(media.position, 0);
      const repeatedId = randomUUID();
      const repeated = await publications.addMediaAsAdmin(admin, providerId, draft.id, {
        id: repeatedId, objectKey: `experience-products/${repeatedId}.jpg`, sourceRefHash: "a".repeat(64),
        width: 1200, height: 800, byteSize: 4096, altText: "Synthetic craft materials", altTextJa: "合成の工芸材料", publicCredit: null,
      });
      assert.equal(repeated.id, mediaId);
      assert.equal(repeated.position, 0);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM experience_product_media_assets WHERE provider_id=$1 AND product_id=$2", [providerId, draft.id])).rows[0]?.n, 1);


      const rule: ScheduleRule = {
        id: randomUUID(), timeZone: "Asia/Tokyo", startsOn: "2099-01-01", localStartTime: "10:00",
        durationMinutes: 90, capacity: 6, bookingCutoffMinutes: 120,
        busyBufferBeforeMinutes: 0, busyBufferAfterMinutes: 0, recurrence: { kind: "WEEKLY" },
      };
      await store.saveDraftScheduleRuleAsAdmin(admin, providerId, draft.id, rule, null, rule.id);
      const versionAfterMedia = (await publications.getAdminDraftProduct(admin, providerId, draft.id)).version;
      await publications.saveSaleTermsAsAdmin(admin, providerId, draft.id, {
        expectedDraftVersion: versionAfterMedia,
        expectedSaleTermsVersion: null,
        saleTerms: {
          offerPrices: null,
          childPricing: null,
          minimumParticipants: 1,
          minimumChargeableParticipants: 1,
          maxPartySize: 6,
          cancellationPolicy: "FREE_UNTIL_24H",
          cancellationWindowMinutesBeforeStart: 1_440,
          cancellationRefundBasisPoints: 10_000,
          minimumAttendance: null,
          bookingQuestions: [],
          conditionsVersion: null,
        },
      });

      await assert.rejects(
        publications.publish({ providerId, nihoUserId: admin.nihoUserId }, draft.id, {
          expectedDraftVersion: versionAfterMedia, expectedStateVersion: null,
          expectedSaleTermsVersion: 1, consentVersion: "publication-consent-synthetic-v1",
          checks: { manuscriptReady: true, photosReady: true },
        }),
        StoreAccessDeniedError,
        "an authenticated Admin is not an OWNER and cannot publish",
      );

      if (kind === "experience") {
        assert.equal((await accounts.grantProviderOwner({ providerId, hostAccountId: ownerId, nowUtc: new Date().toISOString() })).kind, "granted");
      } else {
        assert.deepEqual(await publications.ensureMappedOwnerMembership(owner.nihoUserId), { kind: "linked" });
      }
      await new GuestBookingRepository(pool).setProviderSupportSettings(owner, {
        supportEnabled: false, consentVersion: EXPERIENCE_SUPPORT_CONSENT_VERSION, expectedVersion: 1,
      });
      const inherited = await publications.getProduct(owner, draft.id);
      assert.equal(inherited.publicTitle, draft.publicTitle);
      assert.deepEqual(inherited.content, draft.content);
      assert.equal((await publications.listMedia(owner, draft.id))[0]?.id, mediaId);
      assert.equal((await publications.listActiveSaleOffers(owner, draft.id))[0]?.capacity, 6);
      assert.equal((await publications.getSaleTerms(owner, draft.id)).saleTerms?.cancellationPolicy, "FREE_UNTIL_24H");

      const revision = { expectedDraftVersion: inherited.version, expectedStateVersion: null, expectedSaleTermsVersion: 1 };
      if (kind === "experience") {
        await publications.reviewAdminDraftEnglish(admin, providerId, draft.id, inherited.version);
        const status = () => publications.getAdminDraftPublicationStatus(admin, providerId, draft.id, publicationConsent, payoutConsent);
        assert.deepEqual((await status()).blockers, ["PAYMENT_REUSE_CONSENT_REQUIRED"]);
        const consents = new ProviderPayoutAccountConsents(pool);
        const recordConsent = () => consents.record(owner, {
          stripeConnectAccountRef: stripeAccount, consentVersion: payoutConsent, nowUtc: new Date().toISOString(),
        });
        await recordConsent();
        assert.deepEqual((await status()).blockers, []);
        const accountCheck = { stripeConnectAccountRef: stripeAccount, checkedAtUtc: new Date().toISOString() };
        const publish = (check: typeof accountCheck | null) => publications.publishAdminDraft(admin, providerId, draft.id, {
          ...revision, consentVersion: publicationConsent, payoutConsentVersion: payoutConsent,
          accepted: true, sellerConfirmationMethod: "WRITTEN", photoRightsConfirmed: true, accountCheck: check,
        });
        const blockedBy = (blocker: string) => (error: unknown) => error instanceof ExperiencePublicationBlockedError
          && error.blockers.some((item) => item === blocker);
        await assert.rejects(publish(null), blockedBy("CONNECT_NOT_READY"));
        await assert.rejects(publish({ ...accountCheck, stripeConnectAccountRef: "acct_SyntheticOther" }), blockedBy("CONNECT_NOT_READY"));
        await assert.rejects(publish({ ...accountCheck, checkedAtUtc: new Date(Date.now() - 6 * 60_000).toISOString() }), blockedBy("CONNECT_NOT_READY"));
        await consents.revoke(owner, { nowUtc: new Date().toISOString() });
        await assert.rejects(publish(accountCheck), blockedBy("PAYMENT_REUSE_CONSENT_REQUIRED"));
        await recordConsent();
        await publish(accountCheck);
        assert.equal((await pool.query("SELECT count(*)::int AS n FROM provider_publication_readiness")).rows[0]?.n, 0);
        const proxyAudit = await pool.query(
          "SELECT actor_niho_user_id, seller_confirmation_method FROM admin_proxy_publication_audit_events WHERE provider_id=$1 AND product_id=$2",
          [providerId, draft.id],
        );
        assert.deepEqual(proxyAudit.rows, [{ actor_niho_user_id: admin.nihoUserId, seller_confirmation_method: "WRITTEN" }]);
      } else {
        const now = Date.now();
        await publications.recordReadiness(owner, {
          accountUsable: true, connectReady: true, paymentReuseConsentAccepted: true,
          paymentReuseConsentVersion: "synthetic-payment-reuse-v1",
          paymentReuseConsentedAtUtc: new Date(now - 2_000).toISOString(), sellerDisplayReady: true,
          sellerNihoAccountRef: owner.nihoUserId, stripeConnectAccountRef: stripeAccount,
          sellerDisplayName: "Synthetic Craft Seller", requiredConsentVersion: publicationConsent,
          observedAtUtc: new Date(now - 1_000).toISOString(), validUntilUtc: new Date(now + 60_000).toISOString(),
        }, null);
        await publications.publish(owner, draft.id, {
          ...revision, consentVersion: publicationConsent, checks: { manuscriptReady: true, photosReady: true },
        });
      }
      const publicProduct = await publications.getPublicBySlug(draft.slug);
      assert.equal(publicProduct?.publicTitle, draft.publicTitle);
      assert.equal(publicProduct?.unitAmount, 4_000);
      assert.equal(publicProduct?.photos[0]?.src, `/api/public/experience-media/${mediaId}`);
      await assert.rejects(
        publications.getAdminDraftProduct(admin, providerId, draft.id),
        StoreAccessDeniedError,
        "a published product is no longer available through the Admin draft boundary",
      );

      const audit = await pool.query<{ actor_niho_user_id: string; action: string }>(
        "SELECT actor_niho_user_id,action FROM admin_product_draft_audit_events WHERE provider_id=$1 AND product_id=$2 ORDER BY id",
        [providerId, draft.id],
      );
      assert.deepEqual(audit.rows.map((row) => row.action), ["DRAFT_CREATED", "MEDIA_ADDED", "MEDIA_ADDED", "SCHEDULE_SAVED", "SALE_TERMS_SAVED"]);
      assert.ok(audit.rows.every((row) => row.actor_niho_user_id === admin.nihoUserId));
    } finally {
      await db.dispose();
    }
  });
});
