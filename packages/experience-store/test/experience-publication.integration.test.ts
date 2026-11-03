import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { occurrenceIdFor, type ScheduleRule } from "@niho-experience/experience-domain";
import { StoreAccessDeniedError, StoreConflictError } from "../src/errors.ts";
import { ExperiencePublicationBlockedError, ExperiencePublicationRepository } from "../src/experience-publication.ts";
import { ExperienceStore } from "../src/repository.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
const OWNER = { providerId: "provider-synthetic", nihoUserId: "owner-synthetic" } as const;
const EDITOR = { providerId: OWNER.providerId, nihoUserId: "editor-synthetic" } as const;
const OPS = { nihoUserId: "operations-synthetic" } as const;
const CHECKS = { manuscriptReady: true, photosReady: true } as const;

const manuscript = (description: string) => ({
  lead: "A synthetic lead.",
  description,
  facts: { language: "English" },
  highlights: ["A synthetic highlight."],
  included: ["Synthetic materials"],
  notIncluded: [],
  knowBeforeYouGo: ["Synthetic guidance."],
  notSuitableFor: [],
  timeline: [],
  meetingOverview: "Near a synthetic station.",
  meetingPointDisclosure: "AFTER_BOOKING",
  meetingPoint: null,
} as const);

const readiness = (overrides: Partial<Parameters<ExperiencePublicationRepository["recordReadiness"]>[1]> = {}) => {
  const now = Date.now();
  return {
    accountUsable: true,
    connectReady: true,
    sellerDisplayReady: true,
    sellerNihoAccountRef: "seller-account-synthetic",
    stripeConnectAccountRef: "acct_synthetic_publication",
    sellerDisplayName: "Synthetic Legal Seller",
    requiredConsentVersion: "publication-consent-synthetic-v1",
    observedAtUtc: new Date(now - 1_000).toISOString(),
    validUntilUtc: new Date(now + 60_000).toISOString(),
    ...overrides,
  };
};

describe("Experience publication persistence (#330 #369)", { skip: databaseUrl === undefined ? "TEST_DATABASE_URL is not set" : false }, () => {
  it("publishes only through a current OWNER, preserves an older public copy on incomplete saves, and fails closed", async () => {
    const { Pool } = await import("pg");
    const schema = `experience_publication_${randomUUID().replaceAll("-", "")}`;
    const pool = new Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });
    try {
      await pool.query(`CREATE SCHEMA "${schema}"`);
      const migrations = (await readdir(new URL("../migrations/", import.meta.url))).filter((name) => /^\d{4}.*\.sql$/.test(name)).sort();
      for (const name of migrations) await pool.query(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
      await pool.query("INSERT INTO experience_providers (id) VALUES ($1)", [OWNER.providerId]);
      await pool.query(
        "INSERT INTO provider_memberships (provider_id,niho_user_id,role) VALUES ($1,$2,'OWNER'),($1,$3,'EDITOR')",
        [OWNER.providerId, OWNER.nihoUserId, EDITOR.nihoUserId],
      );

      const store = new ExperienceStore(pool);
      const publications = new ExperiencePublicationRepository(pool);
      const original = await store.createProduct(OWNER, {
        id: "tea-synthetic",
        slug: "synthetic-tea",
        status: "PUBLISHED",
        publicTitle: "Synthetic tea",
        content: manuscript("A synthetic manuscript."),
        currency: "JPY",
        unitAmount: 4_000,
        cancellationTermsRef: "cancellation-synthetic-v1",
        sellerNihoAccountRef: "seller-account-synthetic",
        stripeConnectAccountRef: "acct_synthetic_publication",
        sellerDisplayName: "Synthetic Legal Seller",
      });
      const rule: ScheduleRule = {
        id: "tea-daily",
        timeZone: "Asia/Tokyo",
        startsOn: "2099-01-01",
        localStartTime: "10:00",
        durationMinutes: 90,
        capacity: 6,
        bookingCutoffMinutes: 60,
        busyBufferBeforeMinutes: 0,
        busyBufferAfterMinutes: 0,
        recurrence: { kind: "DAILY" },
      };
      await store.saveScheduleRule(OWNER, original.id, rule, null, "00000000-0000-4000-8000-000000000330");
      await pool.query(
        `INSERT INTO experience_product_sale_terms
           (provider_id,product_id,minimum_participants,max_party_size,cancellation_policy,
            booking_questions,booking_questions_fingerprint,conditions_version)
         VALUES ($1,$2,1,6,'FREE_UNTIL_24H','[]'::jsonb,$3,NULL)`,
        [OWNER.providerId, original.id, "0".repeat(64)],
      );

      // A prior booking proves later draft/publication changes do not rewrite its seller/price/terms snapshots.
      const booking = await store.createBookingHold(OWNER, {
        productId: original.id,
        occurrenceId: occurrenceIdFor(rule.id, "2099-01-01"),
        seats: 2,
        idempotencyKey: "publication-snapshot-synthetic",
      });
      const beforeSnapshots = await pool.query(
        "SELECT pricing_snapshot,seller_snapshot,occurrence_snapshot FROM bookings WHERE public_booking_id=$1::uuid",
        [booking.publicBookingId],
      );

      await assert.rejects(
        publications.recordReadiness({ ...OWNER, calendarRoleCeiling: "EDITOR" }, readiness(), null),
        StoreAccessDeniedError,
      );
      const ready = await publications.recordReadiness(OWNER, readiness(), null);
      assert.equal(ready.version, 1);
      // A migrated/legacy product is never made public merely by recording readiness.
      assert.equal(await publications.getPublicBySlug(original.slug), null);
      await assert.rejects(
        publications.publish(EDITOR, original.id, {
          expectedDraftVersion: original.version,
          expectedStateVersion: null,
          consentVersion: ready.requiredConsentVersion,
          checks: CHECKS,
        }),
        StoreAccessDeniedError,
      );

      let state = await publications.publish(OWNER, original.id, {
        expectedDraftVersion: original.version,
        expectedStateVersion: null,
        consentVersion: ready.requiredConsentVersion,
        checks: CHECKS,
      });
      assert.equal(state.version, 1);
      assert.equal((await publications.getPublicBySlug(original.slug))?.publicTitle, "Synthetic tea");
      assert.deepEqual((await publications.listPublic()).map(({ slug }) => slug), [original.slug]);

      const changed = await publications.saveDraft(EDITOR, {
        id: original.id,
        slug: original.slug,
        publicTitle: "Synthetic tea, revised",
        content: manuscript("A revised synthetic manuscript."),
        currency: "JPY",
        unitAmount: 4_500,
        cancellationTermsRef: "cancellation-synthetic-v2",
      }, original.version, CHECKS);
      assert.equal(changed.publicationUpdated, true);
      assert.equal((await publications.getPublicBySlug(original.slug))?.publicTitle, "Synthetic tea, revised");
      await assert.rejects(
        publications.saveDraft(EDITOR, { ...changed.draft, id: original.id }, original.version, CHECKS),
        StoreConflictError,
      );

      // An incomplete ordinary save remains editable but does not erase or replace the public copy.
      const incomplete = await publications.saveDraft(EDITOR, {
        id: original.id,
        slug: original.slug,
        publicTitle: "Synthetic incomplete draft",
        content: manuscript("Still being edited."),
        currency: "JPY",
        unitAmount: 4_500,
        cancellationTermsRef: "cancellation-synthetic-v2",
      }, changed.draft.version, { manuscriptReady: true, photosReady: false });
      assert.equal(incomplete.publicationUpdated, false);
      assert.ok(incomplete.blockers.includes("PHOTOS_REQUIRED"));
      assert.equal((await publications.getPublicBySlug(original.slug))?.publicTitle, "Synthetic tea, revised");

      state = (await publications.getState(OWNER, original.id))!;
      state = await publications.stop(OWNER, original.id, state.version);
      assert.equal(await publications.getPublicBySlug(original.slug), null);
      await assert.rejects(publications.stop(OWNER, original.id, state.version - 1), StoreConflictError);
      state = await publications.publish(OWNER, original.id, {
        expectedDraftVersion: incomplete.draft.version,
        expectedStateVersion: state.version,
        consentVersion: ready.requiredConsentVersion,
        checks: CHECKS,
      });
      assert.equal((await publications.getPublicBySlug(original.slug))?.publicTitle, "Synthetic incomplete draft");
      assert.ok(state.firstPublishedAtUtc);

      state = await publications.suspendByOperations(OPS, OWNER.providerId, original.id, "POLICY_REVIEW", state.version);
      assert.equal(await publications.getPublicBySlug(original.slug), null);
      await assert.rejects(
        publications.publish(OWNER, original.id, {
          expectedDraftVersion: incomplete.draft.version,
          expectedStateVersion: state.version,
          consentVersion: ready.requiredConsentVersion,
          checks: CHECKS,
        }),
        (error: unknown) => error instanceof ExperiencePublicationBlockedError && error.blockers.includes("OPERATIONS_SUSPENDED"),
      );
      state = await publications.clearOperationsSuspension(OPS, OWNER.providerId, original.id, state.version);
      assert.equal(state.ownerResumeRequired, true);
      assert.equal(await publications.getPublicBySlug(original.slug), null);
      state = await publications.publish(OWNER, original.id, {
        expectedDraftVersion: incomplete.draft.version,
        expectedStateVersion: state.version,
        consentVersion: ready.requiredConsentVersion,
        checks: CHECKS,
      });
      assert.equal(state.ownerResumeRequired, false);
      assert.ok(await publications.getPublicBySlug(original.slug));

      // A current false readiness, expiry, seller mismatch, or OWNER loss all hide the same public copy.
      const notReady = await publications.recordReadiness(OWNER, readiness({ connectReady: false }), ready.version);
      assert.equal(await publications.getPublicBySlug(original.slug), null);
      const expiredNow = Date.now();
      const expired = await publications.recordReadiness(OWNER, readiness({
        observedAtUtc: new Date(expiredNow - 2_000).toISOString(),
        validUntilUtc: new Date(expiredNow - 1_000).toISOString(),
      }), notReady.version);
      assert.equal(await publications.getPublicBySlug(original.slug), null);
      const mismatchedSeller = await publications.recordReadiness(OWNER, readiness({ sellerDisplayName: "Another Synthetic Seller" }), expired.version);
      assert.equal(await publications.getPublicBySlug(original.slug), null);
      const unusableAccount = await publications.recordReadiness(OWNER, readiness({ accountUsable: false }), mismatchedSeller.version);
      assert.equal(await publications.getPublicBySlug(original.slug), null);
      const readyAgain = await publications.recordReadiness(OWNER, readiness(), unusableAccount.version);
      assert.ok(await publications.getPublicBySlug(original.slug));
      await pool.query("UPDATE provider_memberships SET active=false WHERE provider_id=$1 AND niho_user_id=$2", [OWNER.providerId, OWNER.nihoUserId]);
      assert.equal(await publications.getPublicBySlug(original.slug), null);
      assert.equal((await publications.listPublic()).length, 0);
      assert.equal(readyAgain.version, 6);

      const afterSnapshots = await pool.query(
        "SELECT pricing_snapshot,seller_snapshot,occurrence_snapshot FROM bookings WHERE public_booking_id=$1::uuid",
        [booking.publicBookingId],
      );
      assert.deepEqual(afterSnapshots.rows, beforeSnapshots.rows);
      assert.equal((await pool.query("SELECT count(*)::int AS count FROM bookings WHERE public_booking_id=$1::uuid", [booking.publicBookingId])).rows[0]?.count, 1);
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    }
  });
});
