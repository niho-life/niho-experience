import { addLocalDays } from "@niho-experience/experience-domain";
import type { Pool, PoolClient } from "pg";
import { StoreConflictError, StoreNotFoundError, StoreValidationError } from "./errors.ts";
import {
  GUEST_BOOKING_LIMITS,
  GuestBookingRepository,
  MAX_SELLABLE_PRODUCT_ID_LENGTH,
  SALE_SETTINGS_COLUMNS,
  TERMS_COLUMNS,
  activeRules,
  chargeableFee,
  databaseNow,
  expandRules,
  questionsFingerprint,
  saleSettingsFromRow,
  termsFromRow,
  tokyoDate,
  validSaleTerms,
  type ProductSaleTerms,
  type ProductSaleTermsInput,
  type ProviderSaleSettings,
} from "./guest-bookings.ts";
import { PRODUCT_COLUMNS } from "./repository.ts";
import { productFromRow, type DbRow } from "./rows.ts";
import { withTransaction } from "./transaction.ts";
import type { MembershipRole, ProductRecord, ProductStatus } from "./types.ts";
import { assertMoney, assertNonEmptyText, assertStoreIdentifier } from "./validation.ts";

/*
 * The operator's registration of an experience sold on this site (#285 slice 9; docs/guest-booking.md
 * 「体験の登録と切替（第9段）」). Every method here is for scripts/experience/register-site-sale.mjs only:
 * it takes no HostActor and checks no membership, so it must never be reachable from a route. This file
 * is not exported from index.ts (only from the `./site-sale-registration` subpath the script imports),
 * apps/web never imports it, and scripts/gcp/experience-db-grants.mjs lists it in OPERATOR_ONLY_SOURCES:
 * the script runs with the migration identity, so the runtime role gets no write for these methods
 * (runtime-grants.test.ts checks all three).
 */

export type RegistrationOutcome = "CREATED" | "UPDATED" | "UNCHANGED";

const MEMBERSHIP_ROLES: ReadonlySet<string> = new Set(["OWNER", "EDITOR", "VIEWER"]);
const PRODUCT_STATUSES: ReadonlySet<string> = new Set(["DRAFT", "PUBLISHED", "ARCHIVED"]);
/** The product's own slug lock (hashtextextended seed); the other advisory locks use 31, 37 and 41. */
const SLUG_LOCK_SEED = 43;

export interface RegisterProductInput {
  readonly providerId: string;
  readonly productId: string;
  readonly slug: string;
  readonly status: ProductStatus;
  readonly publicTitle: string;
  /** JPY: a product sold here is always in yen. */
  readonly unitAmount: number;
  readonly cancellationTermsRef: string;
  readonly sellerNihoAccountRef: string;
  readonly stripeConnectAccountRef: string;
  readonly sellerDisplayName: string;
}

export interface SiteSaleStateQuery {
  readonly providerId: string;
  readonly productId: string;
  readonly nihoUserId: string;
  readonly slug: string;
}

/** What the database holds now for one registration (the script's plan compares it with the input). */
export interface SiteSaleState {
  readonly providerExists: boolean;
  /** The membership of the input's NIHO user, active or not; null when there is none. */
  readonly membership: { readonly role: MembershipRole; readonly active: boolean } | null;
  readonly product: ProductRecord | null;
  readonly saleSettings: ProviderSaleSettings | null;
  readonly saleTerms: ProductSaleTerms | null;
  /** Another product (of any provider) is PUBLISHED with this slug: publishing this one would stop both. */
  readonly slugPublishedElsewhere: boolean;
  /** Another product of this provider uses the slug (any status): the provider's slugs are unique. */
  readonly slugUsedInProvider: boolean;
  /** This provider's other products that have sale terms: writing fee settings sells them too. */
  readonly otherProductsWithSaleTerms: readonly string[];
}

export type SaleReadinessKey =
  | "PROVIDER"
  | "OWNER"
  | "PRODUCT"
  | "PUBLISHED"
  | "UNIQUE_SLUG"
  | "JPY"
  | "MINIMUM_PRICE"
  | "FEE_SETTINGS"
  | "SALE_TERMS"
  | "NO_CONDITIONS"
  | "SCHEDULE";

export interface SaleReadinessCheck {
  readonly key: SaleReadinessKey;
  readonly ok: boolean;
  /** A fixed English sentence with counts only: no names, addresses or account references. */
  readonly detail: string;
}

export interface SaleReadiness {
  readonly providerId: string;
  readonly productId: string;
  readonly checks: readonly SaleReadinessCheck[];
  /** Every check but the sale terms (and what depends on them) passes: writing the terms opens the sale. */
  readonly readyToOpen: boolean;
  /** Travelers can book it here now: the public booking terms answer for its slug with this product. */
  readonly selling: boolean;
  /** OPEN occurrences that start after now within the public window (today through 89 days later). */
  readonly futureOccurrences: number;
}

/** Checks the sale terms decide; the rest must pass before open-sale writes them. */
const TERMS_KEYS: ReadonlySet<SaleReadinessKey> = new Set(["SALE_TERMS", "NO_CONDITIONS"]);

function validProduct(input: RegisterProductInput): RegisterProductInput {
  if (input === null || typeof input !== "object") throw new StoreValidationError("product must be an object.");
  assertStoreIdentifier(input.providerId, "product.providerId");
  assertStoreIdentifier(input.productId, "product.productId");
  // The guest idempotency key holds the product ID (loadSellable sells nothing longer).
  if (input.productId.length > MAX_SELLABLE_PRODUCT_ID_LENGTH) {
    throw new StoreValidationError(`product.productId must be at most ${MAX_SELLABLE_PRODUCT_ID_LENGTH} characters.`);
  }
  assertNonEmptyText(input.slug, "product.slug", 160);
  if (typeof input.status !== "string" || !PRODUCT_STATUSES.has(input.status)) throw new StoreValidationError("product.status is invalid.");
  assertNonEmptyText(input.publicTitle, "product.publicTitle", 300);
  assertMoney(input.unitAmount, "product.unitAmount");
  assertNonEmptyText(input.cancellationTermsRef, "product.cancellationTermsRef");
  assertNonEmptyText(input.sellerNihoAccountRef, "product.sellerNihoAccountRef", 256);
  assertNonEmptyText(input.stripeConnectAccountRef, "product.stripeConnectAccountRef", 256);
  assertNonEmptyText(input.sellerDisplayName, "product.sellerDisplayName", 300);
  return input;
}

function sameProduct(product: ProductRecord, input: RegisterProductInput): boolean {
  return product.slug === input.slug
    && product.status === input.status
    && product.publicTitle === input.publicTitle
    && product.currency === "JPY"
    && product.unitAmount === input.unitAmount
    && product.cancellationTermsRef === input.cancellationTermsRef
    && product.sellerNihoAccountRef === input.sellerNihoAccountRef
    && product.stripeConnectAccountRef === input.stripeConnectAccountRef
    && product.sellerDisplayName === input.sellerDisplayName;
}

/** The same terms: the questions compare by their fingerprint (their canonical JSON). */
function sameTerms(current: ProductSaleTerms, next: ProductSaleTermsInput, fingerprint: string): boolean {
  const child = (value: ProductSaleTermsInput["childPricing"]) =>
    value === null ? null : [value.priceYen, value.minAge, value.maxAge, value.adultRequired];
  return JSON.stringify(child(current.childPricing)) === JSON.stringify(child(next.childPricing))
    && current.minimumParticipants === next.minimumParticipants
    && current.maxPartySize === next.maxPartySize
    && current.cancellationPolicy === next.cancellationPolicy
    && current.bookingQuestionsFingerprint === fingerprint
    && current.conditionsVersion === next.conditionsVersion;
}

function assertExpectedVersion(expectedVersion: number | undefined): void {
  if (expectedVersion !== undefined && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)) {
    throw new StoreValidationError("expectedVersion must be a positive integer.");
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23505";
}

async function requireProvider(client: PoolClient, providerId: string): Promise<void> {
  const provider = await client.query("SELECT 1 FROM experience_providers WHERE id=$1 FOR SHARE", [providerId]);
  if (provider.rows[0] === undefined) throw new StoreNotFoundError("provider");
}

export class SiteSaleRegistration {
  readonly #pool: Pool;
  readonly #guests: GuestBookingRepository;

  constructor(pool: Pool) {
    this.#pool = pool;
    this.#guests = new GuestBookingRepository(pool);
  }

  /**
   * Whether this connection may write the registration: the migration identity can, the runtime role cannot
   * (by design it has no INSERT on providers and memberships and no DELETE on sale terms).
   */
  async canRegister(): Promise<boolean> {
    const result = await this.#pool.query<DbRow>(
      `SELECT has_table_privilege(current_user, 'experience_providers', 'INSERT')
          AND has_table_privilege(current_user, 'provider_memberships', 'INSERT')
          AND has_table_privilege(current_user, 'provider_memberships', 'UPDATE')
          AND has_table_privilege(current_user, 'experience_products', 'INSERT')
          AND has_table_privilege(current_user, 'experience_products', 'UPDATE')
          AND has_table_privilege(current_user, 'provider_sale_settings', 'INSERT')
          AND has_table_privilege(current_user, 'provider_sale_settings', 'UPDATE')
          AND has_table_privilege(current_user, 'experience_product_sale_terms', 'INSERT')
          AND has_table_privilege(current_user, 'experience_product_sale_terms', 'UPDATE')
          AND has_table_privilege(current_user, 'experience_product_sale_terms', 'DELETE') AS allowed`,
    );
    return result.rows[0]?.allowed === true;
  }

  /** Read only: what the database holds for this provider, NIHO user, product and slug. */
  async currentState(query: SiteSaleStateQuery): Promise<SiteSaleState> {
    assertStoreIdentifier(query.providerId, "providerId");
    assertStoreIdentifier(query.productId, "productId");
    assertStoreIdentifier(query.nihoUserId, "nihoUserId");
    assertNonEmptyText(query.slug, "slug", 160);
    const pool = this.#pool;
    const [provider, membership, product, settings, terms, slug, others] = await Promise.all([
      pool.query("SELECT 1 FROM experience_providers WHERE id=$1", [query.providerId]),
      pool.query<DbRow>("SELECT role, active FROM provider_memberships WHERE provider_id=$1 AND niho_user_id=$2", [query.providerId, query.nihoUserId]),
      pool.query<DbRow>(`SELECT ${PRODUCT_COLUMNS} FROM experience_products WHERE provider_id=$1 AND id=$2`, [query.providerId, query.productId]),
      pool.query<DbRow>(`SELECT ${SALE_SETTINGS_COLUMNS} FROM provider_sale_settings WHERE provider_id=$1`, [query.providerId]),
      pool.query<DbRow>(`SELECT ${TERMS_COLUMNS} FROM experience_product_sale_terms WHERE provider_id=$1 AND product_id=$2`, [query.providerId, query.productId]),
      pool.query<DbRow>(
        `SELECT bool_or(status='PUBLISHED') AS published, bool_or(provider_id=$2) AS in_provider
           FROM experience_products WHERE slug=$1 AND NOT (provider_id=$2 AND id=$3)`,
        [query.slug, query.providerId, query.productId],
      ),
      pool.query<DbRow>(
        `SELECT product_id FROM experience_product_sale_terms WHERE provider_id=$1 AND product_id<>$2 ORDER BY product_id COLLATE "C"`,
        [query.providerId, query.productId],
      ),
    ]);
    const member = membership.rows[0];
    const slugRow = slug.rows[0];
    return {
      providerExists: provider.rows[0] !== undefined,
      membership: member === undefined ? null : { role: String(member.role) as MembershipRole, active: member.active === true },
      product: product.rows[0] === undefined ? null : productFromRow(product.rows[0]),
      saleSettings: settings.rows[0] === undefined ? null : saleSettingsFromRow(settings.rows[0]),
      saleTerms: terms.rows[0] === undefined ? null : termsFromRow(terms.rows[0]),
      slugPublishedElsewhere: slugRow?.published === true,
      slugUsedInProvider: slugRow?.in_provider === true,
      otherProductsWithSaleTerms: others.rows.map((row) => String(row.product_id)),
    };
  }

  /**
   * Registers the provider under NIHO's provider ID (the ID /host gets from NIHO), once. The table holds
   * the ID only (no name: /host shows NIHO's), so a provider that exists is UNCHANGED.
   */
  async registerProvider(input: { readonly providerId: string }): Promise<RegistrationOutcome> {
    if (input === null || typeof input !== "object") throw new StoreValidationError("provider must be an object.");
    assertStoreIdentifier(input.providerId, "providerId");
    const result = await this.#pool.query(
      "INSERT INTO experience_providers (id) VALUES ($1) ON CONFLICT (id) DO NOTHING RETURNING id",
      [input.providerId],
    );
    return result.rows[0] === undefined ? "UNCHANGED" : "CREATED";
  }

  /**
   * Links a NIHO user to the provider with this role, active: a new membership, a changed role or a
   * deactivated membership turned on again. The same role, already active, is UNCHANGED.
   */
  async linkProviderMember(input: { readonly providerId: string; readonly nihoUserId: string; readonly role: MembershipRole }): Promise<RegistrationOutcome> {
    if (input === null || typeof input !== "object") throw new StoreValidationError("membership must be an object.");
    assertStoreIdentifier(input.providerId, "providerId");
    assertStoreIdentifier(input.nihoUserId, "nihoUserId");
    if (typeof input.role !== "string" || !MEMBERSHIP_ROLES.has(input.role)) throw new StoreValidationError("role is invalid.");
    try {
      return await withTransaction(this.#pool, async (client) => {
        await requireProvider(client, input.providerId);
        const current = await client.query<DbRow>(
          "SELECT role, active FROM provider_memberships WHERE provider_id=$1 AND niho_user_id=$2 FOR UPDATE",
          [input.providerId, input.nihoUserId],
        );
        const row = current.rows[0];
        if (row === undefined) {
          await client.query(
            "INSERT INTO provider_memberships (provider_id, niho_user_id, role, active) VALUES ($1,$2,$3,true)",
            [input.providerId, input.nihoUserId, input.role],
          );
          return "CREATED";
        }
        if (String(row.role) === input.role && row.active === true) return "UNCHANGED";
        await client.query(
          `UPDATE provider_memberships SET role=$3, active=true, updated_at=clock_timestamp()
            WHERE provider_id=$1 AND niho_user_id=$2`,
          [input.providerId, input.nihoUserId, input.role],
        );
        return "UPDATED";
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new StoreConflictError("The membership changed while it was being linked; run again.");
      throw error;
    }
  }

  /**
   * Registers the product in JPY. A new product needs no expectedVersion (with one it is a conflict); the
   * same fields again are UNCHANGED whatever the version; other fields need the current version. Its
   * content stays as it is (NIHO's page still provides it). A PUBLISHED product whose slug another product
   * already publishes is refused: two published products with one slug stop the sale of both.
   */
  async registerProduct(rawInput: RegisterProductInput, expectedVersion?: number): Promise<{ readonly product: ProductRecord; readonly outcome: RegistrationOutcome }> {
    const input = validProduct(rawInput);
    assertExpectedVersion(expectedVersion);
    try {
      return await withTransaction(this.#pool, async (client) => {
        // Serializes registrations of one slug, so two cannot both see it free.
        await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, ${SLUG_LOCK_SEED}))`, [`experience-product-slug:${input.slug}`]);
        await requireProvider(client, input.providerId);
        const holders = await client.query<DbRow>(
          `SELECT provider_id, status FROM experience_products WHERE slug=$1 AND NOT (provider_id=$2 AND id=$3)`,
          [input.slug, input.providerId, input.productId],
        );
        if (holders.rows.some((row) => String(row.provider_id) === input.providerId)) {
          throw new StoreConflictError("Another product of this provider already uses this slug.");
        }
        if (input.status === "PUBLISHED" && holders.rows.some((row) => String(row.status) === "PUBLISHED")) {
          throw new StoreConflictError("Another provider already publishes this slug; publishing it again would stop the sale of both.");
        }
        const current = await client.query<DbRow>(
          `SELECT ${PRODUCT_COLUMNS} FROM experience_products WHERE provider_id=$1 AND id=$2 FOR UPDATE`,
          [input.providerId, input.productId],
        );
        const values = [
          input.providerId, input.productId, input.slug, input.status, input.publicTitle, input.unitAmount,
          input.cancellationTermsRef, input.sellerNihoAccountRef, input.stripeConnectAccountRef, input.sellerDisplayName,
        ];
        const existing = current.rows[0] === undefined ? null : productFromRow(current.rows[0]);
        if (existing === null) {
          if (expectedVersion !== undefined) throw new StoreConflictError("The product does not exist at that version.");
          const inserted = await client.query<DbRow>(
            `INSERT INTO experience_products (
               provider_id, id, slug, status, public_title, currency, unit_amount,
               cancellation_terms_ref, seller_niho_account_ref, stripe_connect_account_ref, seller_display_name
             ) VALUES ($1,$2,$3,$4,$5,'JPY',$6,$7,$8,$9,$10)
             RETURNING ${PRODUCT_COLUMNS}`,
            values,
          );
          return { product: productFromRow(inserted.rows[0]!), outcome: "CREATED" as const };
        }
        if (sameProduct(existing, input)) return { product: existing, outcome: "UNCHANGED" as const };
        if (expectedVersion !== existing.version) throw new StoreConflictError("Product version mismatch: read the product again.");
        const updated = await client.query<DbRow>(
          `UPDATE experience_products
              SET slug=$3, status=$4, public_title=$5, currency='JPY', unit_amount=$6, cancellation_terms_ref=$7,
                  seller_niho_account_ref=$8, stripe_connect_account_ref=$9, seller_display_name=$10,
                  version=version+1, updated_at=clock_timestamp()
            WHERE provider_id=$1 AND id=$2 AND version=$11
            RETURNING ${PRODUCT_COLUMNS}`,
          [...values, expectedVersion],
        );
        if (updated.rows[0] === undefined) throw new StoreConflictError("Product version mismatch: read the product again.");
        return { product: productFromRow(updated.rows[0]), outcome: "UPDATED" as const };
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new StoreConflictError("The product ID or slug is already in use in this provider.");
      throw error;
    }
  }

  /** NIHO's fee for the provider (GuestBookingRepository.setProviderSaleSettings, reused as it is). */
  async setProviderSaleSettings(providerId: string, input: { readonly supportEnabled: boolean }, expectedVersion?: number): Promise<ProviderSaleSettings> {
    return this.#guests.setProviderSaleSettings(providerId, input, expectedVersion);
  }

  /**
   * Writes the product's sale terms, which opens the sale here when the rest is ready ("この商品はここで
   * 売る"). The validation and the questions' fingerprint are setSaleTerms'. New terms need no
   * expectedVersion (with one it is a conflict); the same terms again are UNCHANGED; other terms need the
   * current version.
   */
  async setSaleTermsAsOperator(
    providerId: string,
    productId: string,
    rawTerms: ProductSaleTermsInput,
    expectedVersion?: number,
  ): Promise<{ readonly terms: ProductSaleTerms; readonly outcome: RegistrationOutcome }> {
    assertStoreIdentifier(providerId, "providerId");
    assertStoreIdentifier(productId, "productId");
    const terms = validSaleTerms(rawTerms);
    assertExpectedVersion(expectedVersion);
    const fingerprint = questionsFingerprint(terms.bookingQuestions);
    return withTransaction(this.#pool, async (client) => {
      const product = await client.query("SELECT 1 FROM experience_products WHERE provider_id=$1 AND id=$2 FOR SHARE", [providerId, productId]);
      if (product.rows[0] === undefined) throw new StoreNotFoundError("product");
      const current = await client.query<DbRow>(
        `SELECT ${TERMS_COLUMNS} FROM experience_product_sale_terms WHERE provider_id=$1 AND product_id=$2 FOR UPDATE`,
        [providerId, productId],
      );
      const child = terms.childPricing;
      const values = [
        providerId, productId, child?.priceYen ?? null, child?.minAge ?? null, child?.maxAge ?? null, child?.adultRequired ?? null,
        terms.minimumParticipants, terms.maxPartySize, terms.cancellationPolicy, JSON.stringify(terms.bookingQuestions),
        fingerprint, terms.conditionsVersion,
      ];
      const existing = current.rows[0] === undefined ? null : termsFromRow(current.rows[0]);
      if (existing === null) {
        if (expectedVersion !== undefined) throw new StoreConflictError("The sale terms do not exist at that version.");
        const inserted = await client.query<DbRow>(
          `INSERT INTO experience_product_sale_terms (
             provider_id, product_id, child_price_amount, child_min_age, child_max_age, child_adult_required,
             minimum_participants, max_party_size, cancellation_policy, booking_questions,
             booking_questions_fingerprint, conditions_version
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)
           RETURNING ${TERMS_COLUMNS}`,
          values,
        );
        return { terms: termsFromRow(inserted.rows[0]!), outcome: "CREATED" as const };
      }
      if (sameTerms(existing, terms, fingerprint)) return { terms: existing, outcome: "UNCHANGED" as const };
      if (expectedVersion !== existing.version) throw new StoreConflictError("Sale terms version mismatch: read the sale terms again.");
      const updated = await client.query<DbRow>(
        `UPDATE experience_product_sale_terms
            SET child_price_amount=$3, child_min_age=$4, child_max_age=$5, child_adult_required=$6,
                minimum_participants=$7, max_party_size=$8, cancellation_policy=$9, booking_questions=$10::jsonb,
                booking_questions_fingerprint=$11, conditions_version=$12,
                version=version+1, updated_at=clock_timestamp()
          WHERE provider_id=$1 AND product_id=$2 AND version=$13
          RETURNING ${TERMS_COLUMNS}`,
        [...values, expectedVersion],
      );
      if (updated.rows[0] === undefined) throw new StoreConflictError("Sale terms version mismatch: read the sale terms again.");
      return { terms: termsFromRow(updated.rows[0]), outcome: "UPDATED" as const };
    });
  }

  /**
   * Stops the sale here: removes the product's sale terms (none is fine). A checkout already holding seats
   * locks the terms FOR SHARE, so this waits for it; later checkouts find nothing for sale. Bookings and
   * holds already made stay as they are.
   */
  async removeSaleTerms(providerId: string, productId: string): Promise<{ readonly removed: boolean }> {
    assertStoreIdentifier(providerId, "providerId");
    assertStoreIdentifier(productId, "productId");
    const result = await this.#pool.query(
      "DELETE FROM experience_product_sale_terms WHERE provider_id=$1 AND product_id=$2 RETURNING version",
      [providerId, productId],
    );
    return { removed: result.rows[0] !== undefined };
  }

  /**
   * What is missing for this product to be sold here, check by check, and whether it is sold now (the
   * same answer as the public booking terms for its slug).
   */
  async saleReadiness(providerId: string, productId: string): Promise<SaleReadiness> {
    assertStoreIdentifier(providerId, "providerId");
    assertStoreIdentifier(productId, "productId");
    const pool = this.#pool;
    const [provider, owners, productRows, settingsRows, termsRows] = await Promise.all([
      pool.query("SELECT 1 FROM experience_providers WHERE id=$1", [providerId]),
      pool.query<DbRow>("SELECT count(*)::int AS owners FROM provider_memberships WHERE provider_id=$1 AND role='OWNER' AND active", [providerId]),
      pool.query<DbRow>(`SELECT ${PRODUCT_COLUMNS} FROM experience_products WHERE provider_id=$1 AND id=$2`, [providerId, productId]),
      pool.query<DbRow>(`SELECT ${SALE_SETTINGS_COLUMNS} FROM provider_sale_settings WHERE provider_id=$1`, [providerId]),
      pool.query<DbRow>(`SELECT ${TERMS_COLUMNS} FROM experience_product_sale_terms WHERE provider_id=$1 AND product_id=$2`, [providerId, productId]),
    ]);
    const product = productRows.rows[0] === undefined ? null : productFromRow(productRows.rows[0]);
    const settings = settingsRows.rows[0] === undefined ? null : saleSettingsFromRow(settingsRows.rows[0]);
    const terms = termsRows.rows[0] === undefined ? null : termsFromRow(termsRows.rows[0]);
    const ownerCount = Number(owners.rows[0]?.owners ?? 0);
    const checks: SaleReadinessCheck[] = [];
    const add = (key: SaleReadinessKey, ok: boolean, okDetail: string, failDetail: string) =>
      checks.push({ key, ok, detail: ok ? okDetail : failDetail });

    add("PROVIDER", provider.rows[0] !== undefined, "The provider is registered.", "The provider is not registered.");
    add("OWNER", ownerCount > 0, `${ownerCount} active OWNER membership(s).`, "No active OWNER membership: nobody can see the bookings in /host.");
    add("PRODUCT", product !== null && product.id.length <= MAX_SELLABLE_PRODUCT_ID_LENGTH,
      "The product is registered.",
      product === null ? "The product is not registered." : `The product ID is longer than ${MAX_SELLABLE_PRODUCT_ID_LENGTH} characters.`);
    let futureOccurrences = 0;
    if (product !== null) {
      add("PUBLISHED", product.status === "PUBLISHED", "The product is PUBLISHED.", `The product is ${product.status}, not PUBLISHED.`);
      const others = await pool.query<DbRow>(
        "SELECT count(*)::int AS others FROM experience_products WHERE slug=$1 AND status='PUBLISHED' AND NOT (provider_id=$2 AND id=$3)",
        [product.slug, providerId, productId],
      );
      const otherCount = Number(others.rows[0]?.others ?? 0);
      add("UNIQUE_SLUG", otherCount === 0, "No other product publishes the slug.", `${otherCount} other published product(s) have the slug: neither is sold.`);
      add("JPY", product.currency === "JPY", "The price is in JPY.", "The price is not in JPY.");
      add("MINIMUM_PRICE", product.unitAmount >= GUEST_BOOKING_LIMITS.minimumChargeYen,
        `The price is at least ¥${GUEST_BOOKING_LIMITS.minimumChargeYen}.`, `The price is below ¥${GUEST_BOOKING_LIMITS.minimumChargeYen}, Stripe's smallest charge.`);
      const feeOk = settings !== null && chargeableFee(product.unitAmount, terms?.childPricing ?? null, settings.platformFeeBasisPoints);
      add("FEE_SETTINGS", feeOk,
        `NIHO's fee is set (support ${settings?.supportEnabled === true ? "on, 15%" : "off, 10%"}).`,
        settings === null ? "NIHO's fee is not set for the provider." : "NIHO's fee on the smallest charge is not one Stripe accepts.");
      add("SALE_TERMS", terms !== null, "The sale terms are written.", "No sale terms: the product is not sold here.");
      add("NO_CONDITIONS", terms === null || terms.conditionsVersion === null,
        "No participation conditions to consent to.", "The sale terms name a conditions version this site cannot show yet: every checkout would be refused.");
      const now = await databaseNow(pool);
      const today = tokyoDate(now);
      const rules = await activeRules(pool, providerId, productId, today);
      const occurrences = await expandRules(pool, providerId, rules, today, addLocalDays(today, GUEST_BOOKING_LIMITS.windowDays - 1));
      futureOccurrences = occurrences.filter(({ occurrence }) => occurrence.status === "OPEN" && Date.parse(occurrence.startUtc) > Date.parse(now)).length;
      add("SCHEDULE", futureOccurrences > 0,
        `${rules.length} schedule rule(s), ${futureOccurrences} open occurrence(s) in the next ${GUEST_BOOKING_LIMITS.windowDays} days.`,
        rules.length === 0 ? "No active schedule rule: the host sets one in /host/calendar." : "No open occurrence in the next 90 days.");
    }
    const sold = product === null ? null : await this.#guests.publicBookingTerms(product.slug);
    const selling = sold !== null && sold.providerId === providerId && sold.productId === productId;
    const readyToOpen = product !== null && checks.every((check) => check.ok || TERMS_KEYS.has(check.key));
    return { providerId, productId, checks, readyToOpen, selling, futureOccurrences };
  }
}
