import { parseScheduleRule, type ScheduleRule } from "@niho-experience/experience-domain";
import type { Pool } from "pg";
import { StoreConflictError, StoreNotFoundError, StoreValidationError } from "./errors.ts";
import { questionsFingerprint, validSaleTerms, writeOfferPrices, type ProductSaleTermsInput } from "./guest-bookings.ts";
import { lockProviderInventory } from "./inventory.ts";
import type { ProductInput } from "./types.ts";
import { validateProduct } from "./repository.ts";
import { withTransaction } from "./transaction.ts";
import { assertStoreIdentifier } from "./validation.ts";

export interface ImportedExperienceProductBundle {
  readonly providerId: string;
  /** Old NIHO sale must be stopped before this atomic import is invoked. */
  readonly legacySaleStoppedConfirmed: true;
  readonly product: ProductInput;
  readonly saleTerms: ProductSaleTermsInput;
  readonly scheduleRules: readonly ScheduleRule[];
}

/**
 * Operator-only initial import for one legacy product. The product, sale terms,
 * schedules, and legacy checkout exclusion are committed together, so a
 * PUBLISHED product can never briefly enter Experience checkout without its
 * cutover gate. Existing provider OWNER membership must already be provisioned.
 */
export class ExperienceProductMigrationImport {
  readonly #pool: Pool;

  constructor(pool: Pool) { this.#pool = pool; }

  async importBundle(raw: ImportedExperienceProductBundle): Promise<{ readonly providerId: string; readonly productId: string; readonly productVersion: 1; readonly scheduleCount: number }> {
    if (!raw || typeof raw !== "object" || raw.legacySaleStoppedConfirmed !== true) {
      throw new StoreValidationError("The operator must confirm the legacy sale is stopped before import.");
    }
    assertStoreIdentifier(raw.providerId, "providerId");
    const product = validateProduct(raw.product);
    if (product.status !== "PUBLISHED") throw new StoreValidationError("Imported legacy products must preserve their active sale status.");
    const terms = validSaleTerms(raw.saleTerms);
    if (!Array.isArray(raw.scheduleRules) || raw.scheduleRules.length < 1 || raw.scheduleRules.length > 100) {
      throw new StoreValidationError("scheduleRules must contain 1-100 rules.");
    }
    const rules = raw.scheduleRules.map((rule) => parseScheduleRule(rule));
    if (new Set(rules.map((rule) => rule.id)).size !== rules.length) throw new StoreValidationError("schedule rule IDs must be unique.");
    const fingerprint = questionsFingerprint(terms.bookingQuestions);

    return withTransaction(this.#pool, async (client) => {
      await lockProviderInventory(client, raw.providerId);
      const provider = await client.query(
        `SELECT 1 FROM experience_providers WHERE id=$1 FOR SHARE`, [raw.providerId],
      );
      if (provider.rows.length !== 1) throw new StoreNotFoundError("provider");
      const owners = await client.query(
        `SELECT niho_user_id FROM provider_memberships
          WHERE provider_id=$1 AND role='OWNER' AND active=true FOR SHARE`, [raw.providerId],
      );
      if (owners.rows.length !== 1) throw new StoreConflictError("Product import requires exactly one active OWNER membership.");
      const fee = await client.query("SELECT 1 FROM provider_sale_settings WHERE provider_id=$1", [raw.providerId]);
      if (fee.rows.length !== 1) throw new StoreConflictError("Provider sale settings must be migrated before the product.");
      const existing = await client.query(
        "SELECT 1 FROM experience_products WHERE provider_id=$1 AND (id=$2 OR slug=$3)",
        [raw.providerId, product.id, product.slug],
      );
      if (existing.rows.length > 0) throw new StoreConflictError("The product ID or slug has already been imported.");

      await client.query(
        `INSERT INTO experience_products
           (provider_id,id,slug,status,public_title,content,currency,unit_amount,cancellation_terms_ref,
            seller_niho_account_ref,stripe_connect_account_ref,seller_display_name)
         VALUES ($1,$2,$3,'PUBLISHED',$4,$5::jsonb,$6,$7,$8,$9,$10,$11)`,
        [raw.providerId, product.id, product.slug, product.publicTitle, JSON.stringify(product.content), product.currency,
          product.unitAmount, product.cancellationTermsRef, product.sellerNihoAccountRef, product.stripeConnectAccountRef,
          product.sellerDisplayName],
      );
      await client.query(
        `INSERT INTO experience_product_sale_terms
           (provider_id,product_id,child_price_amount,child_min_age,child_max_age,child_adult_required,
            minimum_participants,minimum_chargeable_participants,private_booking,max_party_size,cancellation_policy,
            cancellation_window_minutes_before_start,cancellation_refund_basis_points,minimum_attendance,booking_questions,
            booking_questions_fingerprint,conditions_version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17)`,
        [raw.providerId, product.id, terms.childPricing?.priceYen ?? null, terms.childPricing?.minAge ?? null,
          terms.childPricing?.maxAge ?? null, terms.childPricing?.adultRequired ?? null, terms.minimumParticipants,
          terms.minimumChargeableParticipants, terms.privateBooking, terms.maxPartySize, terms.cancellationPolicy,
          terms.cancellationWindowMinutesBeforeStart, terms.cancellationRefundBasisPoints, terms.minimumAttendance,
          JSON.stringify(terms.bookingQuestions), fingerprint, terms.conditionsVersion],
      );
      for (const rule of rules) {
        await client.query(
          `INSERT INTO schedule_rules
             (provider_id,id,product_id,time_zone,starts_on,ends_on,local_start_time,duration_minutes,capacity,
              booking_cutoff_minutes,busy_buffer_before_minutes,busy_buffer_after_minutes,recurrence)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)`,
          [raw.providerId, rule.id, product.id, rule.timeZone, rule.startsOn, rule.endsOn ?? null, rule.localStartTime,
            rule.durationMinutes, rule.capacity, rule.bookingCutoffMinutes, rule.busyBufferBeforeMinutes,
            rule.busyBufferAfterMinutes, JSON.stringify(rule.recurrence)],
        );
      }
      await writeOfferPrices(client, raw.providerId, product.id, terms.offerPrices, 1);
      await client.query(
        `INSERT INTO experience_product_cutovers (provider_id,product_id,legacy_sales_stopped_at)
         VALUES ($1,$2,clock_timestamp())`,
        [raw.providerId, product.id],
      );
      return { providerId: raw.providerId, productId: product.id, productVersion: 1, scheduleCount: rules.length };
    });
  }
}
