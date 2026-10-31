import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { addLocalDays, occurrenceIdFor, type ScheduleRule } from "@niho-experience/experience-domain";
import type { Pool } from "pg";
import { StoreConflictError, StoreNotFoundError, StoreValidationError } from "../src/errors.ts";
import { GuestBookingRepository, type BookingQuestion, type ProductSaleTermsInput } from "../src/guest-bookings.ts";
import { ExperienceStore } from "../src/repository.ts";
import { SiteSaleRegistration, type RegisterProductInput, type SaleReadiness } from "../src/site-sale-registration.ts";
import { parseSiteSaleInput, runSiteSale, type SiteSaleCommand } from "../src/site-sale-script.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
const OWNER = { providerId: "sample-provider-a", nihoUserId: "sample-user-a" } as const;

const QUESTIONS: BookingQuestion[] = [
  { id: "diet", prompt: "Food needs", description: null, inputType: "SINGLE_SELECT", required: true, options: [{ id: "veg", label: "Vegetarian" }, { id: "none", label: "No restrictions" }] },
];
const TERMS: ProductSaleTermsInput = {
  childPricing: { priceYen: 2000, minAge: 6, maxAge: 12, adultRequired: true },
  minimumParticipants: 1,
  maxPartySize: 6,
  cancellationPolicy: "FREE_UNTIL_24H",
  bookingQuestions: QUESTIONS,
  conditionsVersion: null,
};

function product(overrides: Partial<RegisterProductInput> = {}): RegisterProductInput {
  return {
    providerId: "sample-provider-a", productId: "sample-tea", slug: "sample-tea-ceremony", status: "PUBLISHED",
    publicTitle: "Synthetic tea ceremony", unitAmount: 4000, cancellationTermsRef: "sample-terms-v1",
    sellerNihoAccountRef: "sample-seller-a", stripeConnectAccountRef: "acct_SampleSellerA001", sellerDisplayName: "Sample Seller A",
    ...overrides,
  };
}

function day(offset: number): string {
  return addLocalDays(new Date(Date.now() + 9 * 60 * 60 * 1_000).toISOString().slice(0, 10), offset);
}

function rule(id: string, overrides: Partial<ScheduleRule> = {}): ScheduleRule {
  return {
    id, timeZone: "Asia/Tokyo", startsOn: day(1), localStartTime: "10:00", durationMinutes: 90, capacity: 6,
    bookingCutoffMinutes: 60, busyBufferBeforeMinutes: 0, busyBufferAfterMinutes: 0, recurrence: { kind: "DAILY" }, ...overrides,
  };
}

function failing(readiness: SaleReadiness): string[] {
  return readiness.checks.filter((check) => !check.ok).map((check) => check.key);
}

interface Context {
  readonly pool: Pool;
  readonly schema: string;
  readonly registration: SiteSaleRegistration;
  readonly store: ExperienceStore;
  readonly guests: GuestBookingRepository;
}

/** A fresh schema with every migration and no rows: the registration starts from nothing. */
async function withSchema(run: (context: Context) => Promise<void>): Promise<void> {
  const { Pool } = await import("pg");
  const schema = `site_sale_${randomUUID().replaceAll("-", "")}`;
  const pool = new Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });
  try {
    await pool.query(`CREATE SCHEMA "${schema}"`);
    const migrations = (await readdir(new URL("../migrations/", import.meta.url))).filter((name) => /^\d{4}.*\.sql$/.test(name)).sort();
    for (const name of migrations) await pool.query(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
    await run({ pool, schema, registration: new SiteSaleRegistration(pool), store: new ExperienceStore(pool), guests: new GuestBookingRepository(pool) });
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  }
}

/** Provider, OWNER, product and fee: everything register writes. */
async function registered(registration: SiteSaleRegistration): Promise<void> {
  await registration.registerProvider({ providerId: "sample-provider-a" });
  await registration.linkProviderMember({ ...OWNER, role: "OWNER" });
  await registration.registerProduct(product());
  await registration.setProviderSaleSettings("sample-provider-a", { supportEnabled: false });
}

describe("SiteSaleRegistration (#285 slice 9)", { skip: databaseUrl === undefined ? "TEST_DATABASE_URL is not set" : false }, () => {
  it("registers a provider and links its owner idempotently, turning a changed or inactive membership into the asked role", async () => {
    await withSchema(async ({ pool, registration }) => {
      assert.equal(await registration.registerProvider({ providerId: "sample-provider-a" }), "CREATED");
      assert.equal(await registration.registerProvider({ providerId: "sample-provider-a" }), "UNCHANGED");
      assert.equal(await registration.linkProviderMember({ ...OWNER, role: "OWNER" }), "CREATED");
      assert.equal(await registration.linkProviderMember({ ...OWNER, role: "OWNER" }), "UNCHANGED");
      await pool.query("UPDATE provider_memberships SET active=false, role='EDITOR' WHERE niho_user_id='sample-user-a'");
      assert.equal(await registration.linkProviderMember({ ...OWNER, role: "OWNER" }), "UPDATED");
      const rows = await pool.query("SELECT role, active FROM provider_memberships WHERE provider_id='sample-provider-a'");
      assert.deepEqual(rows.rows, [{ role: "OWNER", active: true }]);
      await assert.rejects(registration.linkProviderMember({ providerId: "sample-provider-x", nihoUserId: "sample-user-a", role: "OWNER" }), StoreNotFoundError);
      await assert.rejects(registration.linkProviderMember({ ...OWNER, role: "ADMIN" as "OWNER" }), StoreValidationError);
      await assert.rejects(registration.registerProvider({ providerId: " bad id" }), StoreValidationError);
    });
  });

  it("registers a product in JPY: the same fields again change nothing, other fields need the current version, the content stays", async () => {
    await withSchema(async ({ pool, registration }) => {
      await assert.rejects(registration.registerProduct(product()), StoreNotFoundError);
      await registration.registerProvider({ providerId: "sample-provider-a" });
      await assert.rejects(registration.registerProduct(product(), 1), StoreConflictError);
      const created = await registration.registerProduct(product());
      assert.equal(created.outcome, "CREATED");
      assert.equal(created.product.currency, "JPY");
      assert.equal(created.product.version, 1);
      await pool.query(`UPDATE experience_products SET content='{"sample":"kept"}'::jsonb WHERE id='sample-tea'`);

      const again = await registration.registerProduct(product());
      assert.equal(again.outcome, "UNCHANGED");
      assert.equal(again.product.version, 1);
      assert.equal((await registration.registerProduct(product(), 7)).outcome, "UNCHANGED");

      await assert.rejects(registration.registerProduct(product({ unitAmount: 4500 })), StoreConflictError);
      await assert.rejects(registration.registerProduct(product({ unitAmount: 4500 }), 2), StoreConflictError);
      const updated = await registration.registerProduct(product({ unitAmount: 4500, publicTitle: "Synthetic tea ceremony, longer" }), 1);
      assert.equal(updated.outcome, "UPDATED");
      assert.equal(updated.product.version, 2);
      assert.equal(updated.product.unitAmount, 4500);
      assert.deepEqual(updated.product.content, { sample: "kept" });

      await assert.rejects(registration.registerProduct(product({ productId: "p".repeat(121) })), StoreValidationError);
      await assert.rejects(registration.registerProduct(product({ unitAmount: -1 })), StoreValidationError);
      await assert.rejects(registration.registerProduct(product({ status: "LIVE" as "PUBLISHED" })), StoreValidationError);
    });
  });

  it("refuses a slug another provider publishes or another product of the provider uses", async () => {
    await withSchema(async ({ pool, registration }) => {
      await registration.registerProvider({ providerId: "sample-provider-a" });
      await registration.registerProvider({ providerId: "sample-provider-b" });
      await registration.registerProduct(product({ providerId: "sample-provider-b", productId: "sample-b-tea", stripeConnectAccountRef: "acct_SampleSellerB001" }));
      await assert.rejects(registration.registerProduct(product()), /publishing it again would stop the sale of both/);
      // A draft with the slug sells nothing and stops nothing.
      assert.equal((await registration.registerProduct(product({ status: "DRAFT" }))).outcome, "CREATED");
      await assert.rejects(registration.registerProduct(product({ status: "PUBLISHED" }), 1), StoreConflictError);
      await assert.rejects(registration.registerProduct(product({ productId: "sample-other", status: "DRAFT" })), /Another product of this provider/);
      await pool.query("UPDATE experience_products SET status='ARCHIVED' WHERE provider_id='sample-provider-b'");
      assert.equal((await registration.registerProduct(product({ status: "PUBLISHED" }), 1)).outcome, "UPDATED");
    });
  });

  it("writes sale terms with setSaleTerms' validation and fingerprint, removes them idempotently and writes them again", async () => {
    await withSchema(async ({ registration, guests }) => {
      await registered(registration);
      await assert.rejects(registration.setSaleTermsAsOperator("sample-provider-a", "sample-none", TERMS), StoreNotFoundError);
      await assert.rejects(registration.setSaleTermsAsOperator("sample-provider-a", "sample-tea", { ...TERMS, maxPartySize: 0 }), StoreValidationError);
      await assert.rejects(registration.setSaleTermsAsOperator("sample-provider-a", "sample-tea", TERMS, 1), StoreConflictError);

      const created = await registration.setSaleTermsAsOperator("sample-provider-a", "sample-tea", TERMS);
      assert.equal(created.outcome, "CREATED");
      const canonical = QUESTIONS.map(({ id, prompt, description, inputType, required, options }) => ({ id, prompt, description, inputType, required, options }));
      assert.equal(created.terms.bookingQuestionsFingerprint, createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex"));
      assert.equal((await registration.setSaleTermsAsOperator("sample-provider-a", "sample-tea", TERMS)).outcome, "UNCHANGED");
      await assert.rejects(registration.setSaleTermsAsOperator("sample-provider-a", "sample-tea", { ...TERMS, maxPartySize: 8 }), StoreConflictError);
      const updated = await registration.setSaleTermsAsOperator("sample-provider-a", "sample-tea", { ...TERMS, maxPartySize: 8 }, 1);
      assert.equal(updated.outcome, "UPDATED");
      assert.equal(updated.terms.version, 2);
      assert.equal((await guests.publicBookingTerms("sample-tea-ceremony"))?.productId, "sample-tea");

      assert.deepEqual(await registration.removeSaleTerms("sample-provider-a", "sample-tea"), { removed: true });
      assert.deepEqual(await registration.removeSaleTerms("sample-provider-a", "sample-tea"), { removed: false });
      assert.equal(await guests.publicBookingTerms("sample-tea-ceremony"), null);
      const reopened = await registration.setSaleTermsAsOperator("sample-provider-a", "sample-tea", TERMS);
      assert.deepEqual([reopened.outcome, reopened.terms.version], ["CREATED", 1]);
    });
  });

  it("reports what is missing until the product is sold, and stops selling when the terms go", async () => {
    await withSchema(async ({ pool, registration, store }) => {
      const empty = await registration.saleReadiness("sample-provider-a", "sample-tea");
      assert.deepEqual(failing(empty), ["PROVIDER", "OWNER", "PRODUCT"]);
      assert.deepEqual([empty.readyToOpen, empty.selling], [false, false]);

      await registered(registration);
      const noSchedule = await registration.saleReadiness("sample-provider-a", "sample-tea");
      assert.deepEqual(failing(noSchedule), ["SALE_TERMS", "SCHEDULE"]);
      assert.equal(noSchedule.readyToOpen, false);

      await store.saveScheduleRule(OWNER, "sample-tea", rule("sample-am"), null, randomUUID());
      const ready = await registration.saleReadiness("sample-provider-a", "sample-tea");
      assert.deepEqual(failing(ready), ["SALE_TERMS"]);
      assert.deepEqual([ready.readyToOpen, ready.selling], [true, false]);
      assert.ok(ready.futureOccurrences >= 80, `${ready.futureOccurrences} future occurrences`);

      await registration.setSaleTermsAsOperator("sample-provider-a", "sample-tea", TERMS);
      const selling = await registration.saleReadiness("sample-provider-a", "sample-tea");
      assert.deepEqual(failing(selling), []);
      assert.deepEqual([selling.readyToOpen, selling.selling], [true, true]);

      await registration.removeSaleTerms("sample-provider-a", "sample-tea");
      const stopped = await registration.saleReadiness("sample-provider-a", "sample-tea");
      assert.deepEqual(failing(stopped), ["SALE_TERMS"]);
      assert.deepEqual([stopped.readyToOpen, stopped.selling], [true, false]);
      await registration.setSaleTermsAsOperator("sample-provider-a", "sample-tea", TERMS);

      // Another provider publishing the slug stops both; the report says why.
      await registration.registerProvider({ providerId: "sample-provider-b" });
      await pool.query(
        `INSERT INTO experience_products (provider_id,id,slug,status,public_title,currency,unit_amount,cancellation_terms_ref,seller_niho_account_ref,stripe_connect_account_ref,seller_display_name)
         VALUES ('sample-provider-b','sample-b-tea','sample-tea-ceremony','PUBLISHED','Synthetic B','JPY',4000,'sample-terms-v1','sample-seller-b','acct_SampleSellerB001','Sample Seller B')`,
      );
      const clash = await registration.saleReadiness("sample-provider-a", "sample-tea");
      assert.deepEqual(failing(clash), ["UNIQUE_SLUG"]);
      assert.deepEqual([clash.readyToOpen, clash.selling], [false, false]);
      await pool.query("DELETE FROM experience_products WHERE provider_id='sample-provider-b'");

      // Participation conditions cannot be shown here yet; a closed or past schedule has no open occurrence.
      await registration.setSaleTermsAsOperator("sample-provider-a", "sample-tea", { ...TERMS, conditionsVersion: "c0".repeat(32) }, 1);
      assert.deepEqual(failing(await registration.saleReadiness("sample-provider-a", "sample-tea")), ["NO_CONDITIONS"]);
      await pool.query("UPDATE schedule_rules SET ends_on=$1::date, starts_on=$2::date WHERE id='sample-am'", [day(-1), day(-5)]);
      assert.deepEqual(failing(await registration.saleReadiness("sample-provider-a", "sample-tea")), ["NO_CONDITIONS", "SCHEDULE"]);
    });
  });

  it("counts only open occurrences: closing every date in the window leaves none", async () => {
    await withSchema(async ({ registration, store }) => {
      await registered(registration);
      await store.saveScheduleRule(OWNER, "sample-tea", rule("sample-once", { startsOn: day(3), endsOn: day(3) }), null, randomUUID());
      assert.equal((await registration.saleReadiness("sample-provider-a", "sample-tea")).futureOccurrences, 1);
      await store.setOccurrenceSalesState(OWNER, "sample-tea", "sample-once", { occurrenceId: occurrenceIdFor("sample-once", day(3)), desiredState: "CLOSED" }, null, randomUUID());
      const closed = await registration.saleReadiness("sample-provider-a", "sample-tea");
      assert.equal(closed.futureOccurrences, 0);
      assert.deepEqual(failing(closed), ["SALE_TERMS", "SCHEDULE"]);
    });
  });

  it("shows the current state for the plan", async () => {
    await withSchema(async ({ registration }) => {
      const query = { providerId: "sample-provider-a", productId: "sample-tea", nihoUserId: "sample-user-a", slug: "sample-tea-ceremony" };
      assert.deepEqual(await registration.currentState(query), {
        providerExists: false, membership: null, product: null, saleSettings: null, saleTerms: null,
        slugPublishedElsewhere: false, slugUsedInProvider: false, otherProductsWithSaleTerms: [],
      });
      await registered(registration);
      await registration.registerProduct(product({ productId: "sample-walk", slug: "sample-walk" }));
      await registration.setSaleTermsAsOperator("sample-provider-a", "sample-walk", TERMS);
      await registration.registerProvider({ providerId: "sample-provider-b" });
      await registration.registerProduct(product({ providerId: "sample-provider-b", productId: "sample-b", slug: "sample-b-slug" }));
      const state = await registration.currentState(query);
      assert.equal(state.providerExists, true);
      assert.deepEqual(state.membership, { role: "OWNER", active: true });
      assert.equal(state.product?.version, 1);
      assert.equal(state.saleSettings?.supportEnabled, false);
      assert.equal(state.saleTerms, null);
      assert.deepEqual(state.otherProductsWithSaleTerms, ["sample-walk"]);
      const clash = await registration.currentState({ ...query, productId: "sample-new", slug: "sample-b-slug" });
      assert.deepEqual([clash.slugPublishedElsewhere, clash.slugUsedInProvider], [true, false]);
      const inProvider = await registration.currentState({ ...query, productId: "sample-new", slug: "sample-walk" });
      assert.deepEqual([inProvider.slugPublishedElsewhere, inProvider.slugUsedInProvider], [true, true]);
      await registration.registerProduct(product({ productId: "sample-walk", slug: "sample-walk", status: "DRAFT" }), 1);
      const draft = await registration.currentState({ ...query, productId: "sample-new", slug: "sample-walk" });
      assert.deepEqual([draft.slugPublishedElsewhere, draft.slugUsedInProvider], [false, true]);
    });
  });

  it("runs the script's commands against the database: register, the host's schedule, open-sale, stop-sale and again", async () => {
    await withSchema(async ({ pool, registration, store, guests }) => {
      const example = JSON.parse(await readFile(new URL("../../../scripts/experience/site-sale.example.json", import.meta.url), "utf8")) as unknown;
      const input = parseSiteSaleInput(example);
      const lines: string[] = [];
      const run = (command: SiteSaleCommand, yes = true) => runSiteSale(command, input, { yes }, {
        store: registration,
        checkStripeAccount: async () => ({
          kind: "ready",
          account: { idLast4: "0001", country: "JP", defaultCurrency: "jpy", chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true },
        }),
        stripeKeyMode: "test",
        out: (line) => lines.push(line),
      });
      const slug = input.product.slug;
      const host = { providerId: input.provider.id, nihoUserId: input.owner.nihoUserId } as const;

      assert.equal(await run("plan", false), 0);
      assert.equal(await run("open-sale"), 1, "open-sale before register");
      assert.equal(await run("register"), 0);
      assert.equal(await run("register"), 0, "register again changes nothing");
      const product = await pool.query("SELECT version, status, currency FROM experience_products");
      assert.deepEqual(product.rows, [{ version: "1", status: "PUBLISHED", currency: "JPY" }]);
      assert.equal(await guests.publicBookingTerms(slug), null, "register does not open the sale");
      assert.equal(await run("open-sale"), 1, "no schedule yet");

      // The OWNER registered by the script sets the schedule in /host/calendar.
      await store.saveScheduleRule(host, input.product.id, rule("sample-am"), null, randomUUID());
      assert.equal(await run("open-sale"), 0);
      assert.equal((await guests.publicBookingTerms(slug))?.productId, input.product.id);
      assert.equal(await run("open-sale"), 0, "open-sale again keeps the same terms");
      assert.equal(await run("stop-sale"), 0);
      assert.equal(await guests.publicBookingTerms(slug), null);
      assert.equal(await run("stop-sale"), 0, "stop-sale again is fine");
      assert.equal(await run("open-sale"), 0, "reopen");
      assert.equal(await run("status", false), 0);
      assert.match(lines.at(-1)!, /selling here now: yes/);
    });
  });

  it("tells a connection that may write the registration from one that may only read", async () => {
    await withSchema(async ({ schema, registration }) => {
      assert.equal(await registration.canRegister(), true);
      const { Pool } = await import("pg");
      // pg_read_all_data reads every table and writes none, like a role without the registration grants.
      const reader = new Pool({ connectionString: databaseUrl, max: 1, options: `-c search_path=${schema} -c role=pg_read_all_data` });
      try {
        const readOnly = new SiteSaleRegistration(reader);
        let allowed: boolean;
        try {
          allowed = await readOnly.canRegister();
        } catch {
          return; // This test database cannot switch to the role; nothing to compare.
        }
        assert.equal(allowed, false);
      } finally {
        await reader.end();
      }
    });
  });
});
