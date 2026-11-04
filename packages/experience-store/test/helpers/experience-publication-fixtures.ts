import type { Pool } from "pg";
import { EXPERIENCE_SUPPORT_CONSENT_VERSION, type GuestBookingRepository } from "../../src/guest-bookings.ts";
import type { HostActor } from "../../src/types.ts";

const TEST_PUBLICATION_CONSENT = "synthetic-owner-publication-v1";

/** Explicit current owner consent is required before these synthetic products can be sold. */
export async function consentSupportOffForTest(guests: Pick<GuestBookingRepository, "setProviderSupportSettings">, actor: HostActor): Promise<void> {
  await guests.setProviderSupportSettings(actor, {
    supportEnabled: false,
    consentVersion: EXPERIENCE_SUPPORT_CONSENT_VERSION,
    expectedVersion: 0,
  });
}

/** Seed the immutable public copies required by guest-booking integration fixtures. */
export async function seedTestPublications(pool: Pool): Promise<void> {
  const products = await pool.query<Record<string, unknown>>(
    `SELECT p.*, m.niho_user_id AS publisher_niho_user_id,
            t.child_price_amount,t.child_min_age,t.child_max_age,t.child_adult_required,
            t.minimum_participants,t.minimum_chargeable_participants,t.max_party_size,t.cancellation_policy,
            t.cancellation_window_minutes_before_start,t.cancellation_refund_basis_points,t.minimum_attendance,
            t.booking_questions,t.booking_questions_fingerprint,t.conditions_version,t.version AS terms_version,
            t.offer_prices_configured
       FROM experience_products p
       JOIN experience_product_sale_terms t ON t.provider_id=p.provider_id AND t.product_id=p.id
       JOIN LATERAL (
         SELECT niho_user_id FROM provider_memberships
          WHERE provider_id=p.provider_id AND role='OWNER' AND active=true
          ORDER BY niho_user_id LIMIT 1
       ) m ON true
      WHERE p.status='PUBLISHED'
      ORDER BY p.provider_id,p.id`,
  );

  for (const row of products.rows) {
    const providerId = String(row.provider_id);
    const productId = String(row.id);
    const offerPrices = row.offer_prices_configured === true
      ? (await pool.query<{ rule_id: string; adult_price_amount: string | number }>(
        `SELECT rule_id,adult_price_amount FROM experience_offer_prices
          WHERE provider_id=$1 AND product_id=$2 ORDER BY rule_id`,
        [providerId, productId],
      )).rows.map((price) => ({ offerId: price.rule_id, adultPriceYen: Number(price.adult_price_amount) }))
      : null;
    const childPricing = row.child_price_amount === null ? null : {
      priceYen: Number(row.child_price_amount), minAge: Number(row.child_min_age),
      maxAge: Number(row.child_max_age), adultRequired: row.child_adult_required === true,
    };
    const saleTermsSnapshot = {
      offerPrices, childPricing,
      minimumParticipants: Number(row.minimum_participants),
      minimumChargeableParticipants: Number(row.minimum_chargeable_participants),
      maxPartySize: Number(row.max_party_size), cancellationPolicy: String(row.cancellation_policy),
      cancellationWindowMinutesBeforeStart: row.cancellation_window_minutes_before_start === null
        ? null : Number(row.cancellation_window_minutes_before_start),
      cancellationRefundBasisPoints: Number(row.cancellation_refund_basis_points),
      minimumAttendance: row.minimum_attendance === null ? null : Number(row.minimum_attendance),
      bookingQuestions: row.booking_questions,
      bookingQuestionsFingerprint: String(row.booking_questions_fingerprint),
      conditionsVersion: row.conditions_version === null ? null : String(row.conditions_version),
    };
    const publication = await pool.query<{ id: string | number }>(
      `INSERT INTO experience_product_publications
         (provider_id,product_id,draft_version,sale_terms_version,slug,public_title,content,currency,unit_amount,
          cancellation_terms_ref,seller_niho_account_ref,stripe_connect_account_ref,seller_display_name,
          consent_version,published_by_niho_user_id,sale_terms_snapshot)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb)
       ON CONFLICT (provider_id,product_id,draft_version,sale_terms_version,consent_version) DO NOTHING
       RETURNING id`,
      [providerId, productId, row.version, row.terms_version, row.slug, row.public_title, JSON.stringify(row.content),
        row.currency, row.unit_amount, row.cancellation_terms_ref, row.seller_niho_account_ref,
        row.stripe_connect_account_ref, row.seller_display_name, TEST_PUBLICATION_CONSENT,
        row.publisher_niho_user_id, JSON.stringify(saleTermsSnapshot)],
    );
    const publicationId = publication.rows[0]?.id ?? (await pool.query<{ id: string | number }>(
      `SELECT id FROM experience_product_publications
        WHERE provider_id=$1 AND product_id=$2 AND draft_version=$3 AND sale_terms_version=$4 AND consent_version=$5`,
      [providerId, productId, row.version, row.terms_version, TEST_PUBLICATION_CONSENT],
    )).rows[0]?.id;
    if (publicationId === undefined) throw new Error(`Synthetic publication was not stored for ${providerId}/${productId}.`);

    await pool.query(
      `INSERT INTO experience_product_publication_states
         (provider_id,product_id,current_publication_id,first_published_at)
       SELECT $1,$2,$3,published_at FROM experience_product_publications WHERE id=$3
       ON CONFLICT (provider_id,product_id) DO UPDATE
         SET current_publication_id=EXCLUDED.current_publication_id,
             first_published_at=COALESCE(experience_product_publication_states.first_published_at,EXCLUDED.first_published_at),
             version=experience_product_publication_states.version+1,updated_at=clock_timestamp()
       WHERE experience_product_publication_states.self_stopped_at IS NULL
         AND experience_product_publication_states.operations_suspended_at IS NULL
         AND experience_product_publication_states.owner_resume_required=false`,
      [providerId, productId, publicationId],
    );
  }
}
