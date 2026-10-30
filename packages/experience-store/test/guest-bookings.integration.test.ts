import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { addLocalDays, addMinutes, occurrenceIdFor, tokyoLocalToUtc, type ScheduleRule } from "@niho-experience/experience-domain";
import type { Pool } from "pg";
import {
  GuestCheckoutError,
  StoreAccessDeniedError,
  StoreConflictError,
  StoreNotFoundError,
  StoreValidationError,
} from "../src/errors.ts";
import {
  GuestBookingRepository,
  type BookingQuestion,
  type GuestBookingStart,
  type ProductSaleTermsInput,
  type PublicOccurrence,
  type StartGuestBookingInput,
} from "../src/guest-bookings.ts";
import { ExperienceStore } from "../src/repository.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
const ownerA = { providerId: "provider-a", nihoUserId: "owner-a" } as const;
const editorA = { providerId: "provider-a", nihoUserId: "editor-a" } as const;
const viewerA = { providerId: "provider-a", nihoUserId: "viewer-a" } as const;
const ownerB = { providerId: "provider-b", nihoUserId: "owner-b" } as const;
const CONSENT = "sample-terms-2026-10";
const CONDITIONS = "c0".repeat(32);

const QUESTIONS: BookingQuestion[] = [
  { id: "diet", prompt: "Food needs", description: null, inputType: "SINGLE_SELECT", required: true, options: [{ id: "veg", label: "Vegetarian" }, { id: "none", label: "No restrictions" }] },
  { id: "interests", prompt: "What interests you?", description: "Pick any", inputType: "MULTI_SELECT", required: false, options: [{ id: "tea", label: "Tea" }, { id: "garden", label: "Garden" }, { id: "history", label: "History" }] },
  { id: "arrival", prompt: "Arrival station", description: null, inputType: "SHORT_TEXT", required: false, options: [] },
  { id: "story", prompt: "Anything else?", description: null, inputType: "LONG_TEXT", required: false, options: [] },
];

const TEA_TERMS: ProductSaleTermsInput = {
  childPricing: { priceYen: 2000, minAge: 6, maxAge: 12, adultRequired: true },
  minimumParticipants: 1,
  maxPartySize: 6,
  cancellationPolicy: "FREE_UNTIL_24H",
  bookingQuestions: QUESTIONS,
  conditionsVersion: CONDITIONS,
};
const PLAIN_TERMS: ProductSaleTermsInput = {
  childPricing: null, minimumParticipants: 1, maxPartySize: 4, cancellationPolicy: "NONE", bookingQuestions: [], conditionsVersion: null,
};
const KIDS_TERMS: ProductSaleTermsInput = {
  ...PLAIN_TERMS, childPricing: { priceYen: 1500, minAge: 4, maxAge: 12, adultRequired: false }, cancellationPolicy: "FREE_UNTIL_48H",
};

/** The computation NIHO and packages/api-client/test/contract.test.ts use. */
function nihoFingerprint(questions: readonly BookingQuestion[]): string {
  const canonical = questions.map((question) => ({
    id: question.id, prompt: question.prompt, description: question.description, inputType: question.inputType, required: question.required,
    options: question.options.map((option) => ({ id: option.id, label: option.label })),
  }));
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
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

/** One adult for the tea ceremony on day 2, with the required answer and both consents. */
function request(overrides: Partial<StartGuestBookingInput> = {}): StartGuestBookingInput {
  return {
    slug: "sample-tea", offerId: "sample-am", occurrenceDate: day(2), adultCount: 1, childCount: 0, expectedTotalYen: 4000,
    bookingQuestionsFingerprint: nihoFingerprint(QUESTIONS), answers: [{ questionId: "diet", optionIds: ["veg"] }],
    termsConsentVersion: CONSENT, currentConsentVersion: CONSENT, conditionsConsentVersion: CONDITIONS,
    guestName: "Sample Guest", guestEmail: "guest@example.com", guestLanguage: "EN", clientRequestKey: randomUUID(), ...overrides,
  };
}

/** The walk: no child price, no questions, no conditions. */
function walkRequest(overrides: Partial<StartGuestBookingInput> = {}): StartGuestBookingInput {
  return request({
    slug: "sample-walk", offerId: "sample-walk-am", expectedTotalYen: 3000, bookingQuestionsFingerprint: nihoFingerprint([]),
    answers: [], conditionsConsentVersion: null, ...overrides,
  });
}

/** The children's craft: children may come without an adult. */
function kidsRequest(overrides: Partial<StartGuestBookingInput> = {}): StartGuestBookingInput {
  return walkRequest({ slug: "sample-kids", offerId: "sample-kids-am", expectedTotalYen: 2500, ...overrides });
}

interface Context {
  readonly pool: Pool;
  readonly store: ExperienceStore;
  readonly guests: GuestBookingRepository;
  readonly addRule: (productId: string, value: ScheduleRule) => Promise<void>;
}

/** A fresh schema with every migration, synthetic providers, members, products and sale terms (no schedule rules). */
async function withSchema(run: (context: Context) => Promise<void>): Promise<void> {
  const { Pool } = await import("pg");
  const schema = `guest_bookings_${randomUUID().replaceAll("-", "")}`;
  const pool = new Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });
  try {
    await pool.query(`CREATE SCHEMA "${schema}"`);
    const migrations = (await readdir(new URL("../migrations/", import.meta.url))).filter((name) => /^\d{4}.*\.sql$/.test(name)).sort();
    for (const name of migrations) await pool.query(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
    await pool.query("INSERT INTO experience_providers (id) VALUES ('provider-a'),('provider-b')");
    await pool.query(
      `INSERT INTO provider_memberships (provider_id,niho_user_id,role,active) VALUES
         ('provider-a','owner-a','OWNER',true),('provider-a','editor-a','EDITOR',true),
         ('provider-a','viewer-a','VIEWER',true),('provider-b','owner-b','OWNER',true)`,
    );
    const product = (provider: string, id: string, slug: string, status: string, title: string, currency: string, amount: number) =>
      `('${provider}','${id}','${slug}','${status}','${title}','{}','${currency}',${amount},'terms-v1','seller-${provider}','acct_Sample${provider === "provider-a" ? "A" : "B"}0001','Sample Seller ${provider === "provider-a" ? "A" : "B"}')`;
    await pool.query(
      `INSERT INTO experience_products
         (provider_id,id,slug,status,public_title,content,currency,unit_amount,cancellation_terms_ref,seller_niho_account_ref,stripe_connect_account_ref,seller_display_name)
       VALUES ${[
         product("provider-a", "tea", "sample-tea", "PUBLISHED", "Synthetic tea ceremony", "JPY", 4000),
         product("provider-a", "walk", "sample-walk", "PUBLISHED", "Synthetic walk", "JPY", 3000),
         product("provider-a", "kids", "sample-kids", "PUBLISHED", "Synthetic craft for children", "JPY", 2500),
         product("provider-a", "draft", "sample-draft", "DRAFT", "Synthetic draft", "JPY", 4000),
         product("provider-a", "archived", "sample-archived", "ARCHIVED", "Synthetic archived", "JPY", 4000),
         product("provider-a", "noterms", "sample-noterms", "PUBLISHED", "Synthetic without terms", "JPY", 4000),
         product("provider-a", "usd", "sample-usd", "PUBLISHED", "Synthetic in dollars", "USD", 4000),
         product("provider-a", "cheap", "sample-cheap", "PUBLISHED", "Synthetic below the minimum charge", "JPY", 30),
         product("provider-a", "dup", "sample-dup", "PUBLISHED", "Synthetic dup A", "JPY", 4000),
         product("provider-b", "dup", "sample-dup", "PUBLISHED", "Synthetic dup B", "JPY", 4000),
       ].join(",")}`,
    );
    const store = new ExperienceStore(pool);
    const guests = new GuestBookingRepository(pool);
    await guests.setSaleTerms(ownerA, "tea", TEA_TERMS);
    await guests.setSaleTerms(ownerA, "walk", PLAIN_TERMS);
    await guests.setSaleTerms(ownerA, "kids", KIDS_TERMS);
    for (const id of ["draft", "archived", "usd", "cheap", "dup"]) await guests.setSaleTerms(ownerA, id, PLAIN_TERMS);
    await guests.setSaleTerms(ownerB, "dup", PLAIN_TERMS);
    const addRule = async (productId: string, value: ScheduleRule) => {
      const actor = productId === "dup-b" ? ownerB : ownerA;
      await store.saveScheduleRule(actor, productId === "dup-b" ? "dup" : productId, value, null, randomUUID());
    };
    await run({ pool, store, guests, addRule });
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  }
}

async function refused(
  attempt: Promise<unknown>,
  code: string,
  details: Partial<Record<"field" | "questionId" | "seatsLeft" | "currentTotalYen" | "occurrenceReason", unknown>> = {},
): Promise<GuestCheckoutError> {
  const error = await attempt.then(() => null, (caught: unknown) => caught);
  assert.ok(error instanceof GuestCheckoutError, `expected ${code}, got ${String(error)}`);
  assert.equal(error.code, code, `${error.code} (${String(error.field)}) instead of ${code}`);
  for (const [key, value] of Object.entries(details)) assert.equal(error[key as keyof GuestCheckoutError], value, `${code}.${key}`);
  return error;
}

function occurrence(occurrences: readonly PublicOccurrence[], offerId: string, date: string): PublicOccurrence | undefined {
  return occurrences.find((candidate) => candidate.offerId === offerId && candidate.date === date);
}

function state(value: PublicOccurrence | undefined): Pick<PublicOccurrence, "bookable" | "seatsLeft" | "reason"> | undefined {
  return value === undefined ? undefined : { bookable: value.bookable, seatsLeft: value.seatsLeft, reason: value.reason };
}

async function payFor(store: ExperienceStore, start: GuestBookingStart, amount: number, event: string) {
  return store.confirmBookingPayment({ providerId: start.booking.providerId }, {
    publicBookingId: start.publicBookingId, connectedAccountId: start.stripeConnectAccountRef, stripePaymentRef: `pi_sample_${event}`,
    stripeEventId: `evt_sample_${event}`, stripeEventType: "checkout.session.completed", eventOccurredAtUtc: new Date().toISOString(),
    amount, currency: "JPY",
  });
}

describe("PostgreSQL guest bookings (#285)", { skip: databaseUrl === undefined }, () => {
  it("sells only what exactly one published JPY product with sale terms offers, and maps rules to offers", async () => {
    await withSchema(async ({ pool, guests, addRule }) => {
      await addRule("tea", rule("sample-am"));
      await addRule("tea", rule("sample-pm", { localStartTime: "14:30", durationMinutes: 120, capacity: 4, recurrence: { kind: "SELECTED_WEEKDAYS", weekdays: ["FRIDAY", "MONDAY"] } }));
      await addRule("tea", rule("sample-old", { startsOn: day(-20), endsOn: day(-1) }));
      await addRule("tea", rule("sample.dotted"));
      for (const id of ["draft", "archived", "noterms", "usd", "cheap", "dup"]) await addRule(id, rule(`sample-${id}-am`));
      await addRule("dup-b", rule("sample-dup-b-am"));

      for (const slug of ["sample-draft", "sample-archived", "sample-dup", "sample-noterms", "sample-usd", "sample-cheap", "sample-missing", ""]) {
        assert.equal(await guests.publicBookingTerms(slug), null, slug);
        assert.equal(await guests.listPublicAvailability(slug), null, slug);
        await assert.rejects(() => guests.startGuestBooking(request({ slug, offerId: `${slug}-am` })), StoreNotFoundError, slug);
      }

      const terms = await guests.publicBookingTerms("sample-tea");
      assert.ok(terms);
      assert.deepEqual(
        { providerId: terms.providerId, productId: terms.productId, title: terms.title, currency: terms.currency, seller: terms.sellerDisplayName, conditions: terms.conditionsVersion },
        { providerId: "provider-a", productId: "tea", title: "Synthetic tea ceremony", currency: "JPY", seller: "Sample Seller A", conditions: CONDITIONS },
      );
      // An ended rule and a rule whose ID is not a public offer ID are not offered.
      assert.deepEqual(terms.offers.map((offer) => offer.id), ["sample-am", "sample-pm"]);
      assert.deepEqual(terms.offers[0], {
        id: "sample-am",
        name: "Synthetic tea ceremony",
        shortDescription: null,
        pricing: { currency: "JPY", taxIncluded: true, adultPriceYen: 4000, child: { priceYen: 2000, minAge: 6, maxAge: 12, adultRequired: true } },
        capacity: 6,
        maxPartySize: 6,
        minimumParticipants: 1,
        durationMinutes: 90,
        startTime: "10:00",
        weekdays: [0, 1, 2, 3, 4, 5, 6],
        cancellationPolicy: { code: "FREE_UNTIL_24H", freeCancellationHoursBefore: 24 },
        acceptanceMode: "INSTANT",
        bookingQuestions: QUESTIONS,
        bookingQuestionsFingerprint: nihoFingerprint(QUESTIONS),
      });
      assert.deepEqual(
        { startTime: terms.offers[1]?.startTime, durationMinutes: terms.offers[1]?.durationMinutes, capacity: terms.offers[1]?.capacity, weekdays: terms.offers[1]?.weekdays },
        { startTime: "14:30", durationMinutes: 120, capacity: 4, weekdays: [1, 5] },
      );

      const kids = await guests.publicBookingTerms("sample-kids");
      assert.deepEqual(kids?.offers, []);
      assert.equal(kids?.conditionsVersion, null);
      await addRule("kids", rule("sample-kids-am", { recurrence: { kind: "WEEKENDS" } }));
      await addRule("walk", rule("sample-walk-am", { recurrence: { kind: "WEEKLY" }, startsOn: day(1) }));
      const kidsOffer = (await guests.publicBookingTerms("sample-kids"))?.offers[0];
      assert.deepEqual(kidsOffer?.weekdays, [0, 6]);
      assert.deepEqual(kidsOffer?.pricing.child, { priceYen: 1500, minAge: 4, maxAge: 12, adultRequired: false });
      assert.deepEqual(kidsOffer?.cancellationPolicy, { code: "FREE_UNTIL_48H", freeCancellationHoursBefore: 48 });
      assert.equal(kidsOffer?.bookingQuestionsFingerprint, "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945");
      const weekday = new Date(`${day(1)}T00:00:00Z`).getUTCDay();
      assert.deepEqual((await guests.publicBookingTerms("sample-walk"))?.offers[0]?.weekdays, [weekday]);
      assert.equal((await guests.publicBookingTerms("sample-walk"))?.offers[0]?.cancellationPolicy.freeCancellationHoursBefore, null);

      // A public offer name is at most 80 characters.
      await pool.query("UPDATE experience_products SET public_title=$1 WHERE id='walk'", [`Synthetic ${"long ".repeat(30)}walk`]);
      const longName = (await guests.publicBookingTerms("sample-walk"))?.offers[0]?.name ?? "";
      assert.equal([...longName].length, 80);
      assert.ok(longName.endsWith("…"));

      // Unpublishing or a second published product with the slug stops the sale.
      await pool.query("UPDATE experience_products SET status='ARCHIVED' WHERE id='kids'");
      assert.equal(await guests.publicBookingTerms("sample-kids"), null);
      await pool.query("UPDATE experience_products SET status='PUBLISHED', slug='sample-tea' WHERE provider_id='provider-b' AND id='dup'");
      assert.equal(await guests.publicBookingTerms("sample-tea"), null);
      await assert.rejects(() => guests.startGuestBooking(request()), StoreNotFoundError);
    });
  });

  it("still sells an occurrence of an ended rule that the host moved to a later day", async () => {
    await withSchema(async ({ pool, guests, addRule }) => {
      await addRule("tea", rule("sample-old", { startsOn: day(-20), endsOn: day(-1) }));
      assert.deepEqual((await guests.publicBookingTerms("sample-tea"))?.offers.map((offer) => offer.id), []);
      // Moved while the rule still ran; the rule has ended since (written directly: the past cannot be moved now).
      await pool.query(
        `INSERT INTO schedule_occurrence_overrides (provider_id, rule_id, occurrence_id, kind, local_date, local_start_time)
         VALUES ('provider-a', 'sample-old', $1, 'RESCHEDULE', $2::date, '15:00')`,
        [occurrenceIdFor("sample-old", day(-2)), day(10)],
      );
      assert.deepEqual((await guests.publicBookingTerms("sample-tea"))?.offers.map((offer) => offer.id), ["sample-old"]);
      const availability = await guests.listPublicAvailability("sample-tea");
      assert.deepEqual(
        availability?.occurrences.map(({ offerId, date, startAt, bookable }) => ({ offerId, date, startAt, bookable })),
        [{ offerId: "sample-old", date: day(10), startAt: tokyoLocalToUtc(day(10), "15:00"), bookable: true }],
      );
      const held = await guests.startGuestBooking(request({ offerId: "sample-old", occurrenceDate: day(10) }));
      assert.equal(held.booking.occurrenceId, occurrenceIdFor("sample-old", day(-2)));
    });
  });

  it("lets OWNER and EDITOR write sale terms at a version, with NIHO's question shape and fingerprint", async () => {
    await withSchema(async ({ guests }) => {
      await assert.rejects(() => guests.setSaleTerms(viewerA, "tea", TEA_TERMS, 1), StoreAccessDeniedError);
      await assert.rejects(() => guests.setSaleTerms({ ...ownerA, calendarScope: "OPERATOR" }, "tea", TEA_TERMS, 1), StoreAccessDeniedError);
      await assert.rejects(() => guests.setSaleTerms({ ...ownerA, calendarRoleCeiling: "VIEWER" }, "tea", TEA_TERMS, 1), StoreAccessDeniedError);
      // Another provider's owner does not see this provider's product.
      await assert.rejects(() => guests.setSaleTerms(ownerB, "tea", TEA_TERMS), StoreNotFoundError);
      // Without a version the terms must be new; with one it must be current.
      await assert.rejects(() => guests.setSaleTerms(ownerA, "tea", TEA_TERMS), StoreConflictError);
      await assert.rejects(() => guests.setSaleTerms(ownerA, "tea", TEA_TERMS, 2), StoreConflictError);
      const changed = await guests.setSaleTerms(editorA, "tea", { ...TEA_TERMS, bookingQuestions: QUESTIONS.slice(0, 1), maxPartySize: 8 }, 1);
      assert.equal(changed.version, 2);
      assert.equal(changed.maxPartySize, 8);
      assert.equal(changed.bookingQuestionsFingerprint, nihoFingerprint(QUESTIONS.slice(0, 1)));
      assert.notEqual(changed.bookingQuestionsFingerprint, nihoFingerprint(QUESTIONS));

      const diet = QUESTIONS[0]!;
      for (const bad of [
        { bookingQuestions: [diet, diet] },
        { bookingQuestions: [{ ...diet, options: diet.options.slice(0, 1) }] },
        { bookingQuestions: [{ ...diet, inputType: "SHORT_TEXT" as const }] },
        { bookingQuestions: [{ ...diet, id: "bad id" }] },
        { bookingQuestions: [{ ...diet, prompt: "" }] },
        { bookingQuestions: [{ ...diet, options: [{ id: "a", label: "A" }, { id: "a", label: "B" }] }] },
        { bookingQuestions: Array.from({ length: 6 }, (_, index) => ({ ...diet, id: `q${index}` })) },
        { childPricing: { priceYen: 0, minAge: 4, maxAge: 12, adultRequired: false } },
        { childPricing: { priceYen: 1000, minAge: 12, maxAge: 6, adultRequired: true } },
        { minimumParticipants: 3, maxPartySize: 2 },
        { maxPartySize: 501 },
        { cancellationPolicy: "FLEXIBLE" as never },
        { conditionsVersion: "not-a-digest" },
      ] satisfies Partial<ProductSaleTermsInput>[]) {
        await assert.rejects(() => guests.setSaleTerms(ownerA, "tea", { ...TEA_TERMS, ...bad }, 2), StoreValidationError, JSON.stringify(bad).slice(0, 80));
      }
    });
  });

  it("shows for each occurrence what a hold will accept: full, cutoff, paused, moved, Google busy and stale", async () => {
    await withSchema(async ({ store, guests, addRule }) => {
      await addRule("tea", rule("sample-am", { capacity: 2 }));
      await addRule("tea", rule("sample-late", { localStartTime: "18:00", bookingCutoffMinutes: 525_600 }));
      const list = async (options: Parameters<GuestBookingRepository["listPublicAvailability"]>[1] = {}) => {
        const availability = await guests.listPublicAvailability("sample-tea", options);
        assert.ok(availability);
        return availability;
      };

      let availability = await list();
      assert.equal(availability.timeZone, "Asia/Tokyo");
      assert.equal(availability.windowDays, 90);
      assert.ok(Math.abs(Date.parse(availability.generatedAt) - Date.now()) < 60_000);
      assert.deepEqual(occurrence(availability.occurrences, "sample-am", day(2)), {
        offerId: "sample-am", date: day(2), startAt: tokyoLocalToUtc(day(2), "10:00"), endAt: addMinutes(tokyoLocalToUtc(day(2), "10:00"), 90),
        bookable: true, seatsLeft: 2, reason: null,
      });
      // Today through 89 days later; the rule starts tomorrow.
      assert.equal(availability.occurrences.filter((item) => item.offerId === "sample-am").length, 89);
      assert.ok(availability.occurrences.every((item) => item.date >= day(1) && item.date <= day(89)));
      const sorted = [...availability.occurrences].sort((a, b) => a.startAt.localeCompare(b.startAt) || a.offerId.localeCompare(b.offerId));
      assert.deepEqual(availability.occurrences, sorted);
      // Narrowing: an offer, a later start, fewer days. A start before today begins today.
      assert.ok((await list({ offerId: "sample-late" })).occurrences.every((item) => item.offerId === "sample-late"));
      assert.deepEqual((await list({ offerId: "sample-am", fromDate: day(10), windowDays: 3 })).occurrences.map((item) => item.date), [day(10), day(11), day(12)]);
      assert.equal((await list({ offerId: "sample-am", fromDate: day(-30), windowDays: 32 })).occurrences.length, 1);
      assert.deepEqual((await list({ fromDate: day(95) })).occurrences, []);
      await assert.rejects(() => guests.listPublicAvailability("sample-tea", { windowDays: 91 }), StoreValidationError);
      await assert.rejects(() => guests.listPublicAvailability("sample-tea", { fromDate: "tomorrow" }), StoreValidationError);

      // Cutoff.
      assert.ok(availability.occurrences.filter((item) => item.offerId === "sample-late").every((item) => !item.bookable && item.reason === "CUTOFF" && item.seatsLeft === 0));
      await refused(guests.startGuestBooking(request({ offerId: "sample-late" })), "OCCURRENCE_INVALID", { occurrenceReason: "CUTOFF" });

      // Full, and partly full.
      await guests.startGuestBooking(request({ adultCount: 2, expectedTotalYen: 8000 }));
      await guests.startGuestBooking(request({ occurrenceDate: day(3), guestEmail: "third@example.com" }));
      availability = await list();
      assert.deepEqual(state(occurrence(availability.occurrences, "sample-am", day(2))), { bookable: false, seatsLeft: 0, reason: "FULL" });
      assert.deepEqual(state(occurrence(availability.occurrences, "sample-am", day(3))), { bookable: true, seatsLeft: 1, reason: null });
      await refused(guests.startGuestBooking(request({ guestEmail: "other@example.com" })), "FULL", { seatsLeft: 0 });
      await refused(guests.startGuestBooking(request({ occurrenceDate: day(3), adultCount: 2, expectedTotalYen: 8000, guestEmail: "other@example.com" })), "FULL", { seatsLeft: 1 });

      // Paused by the host.
      await store.setOccurrenceSalesState(ownerA, "tea", "sample-am", { occurrenceId: occurrenceIdFor("sample-am", day(4)), desiredState: "CLOSED" }, null, randomUUID());
      availability = await list();
      assert.deepEqual(state(occurrence(availability.occurrences, "sample-am", day(4))), { bookable: false, seatsLeft: 0, reason: "UNAVAILABLE" });
      await refused(guests.startGuestBooking(request({ occurrenceDate: day(4), guestEmail: "other@example.com" })), "OCCURRENCE_INVALID", { occurrenceReason: "UNAVAILABLE" });

      // Moved within its day: shown and held at the new time.
      await store.saveOccurrenceOverride(ownerA, "tea", "sample-am", { kind: "RESCHEDULE", occurrenceId: occurrenceIdFor("sample-am", day(5)), localDate: day(5), localStartTime: "15:00" }, null, randomUUID());
      // Moved onto a day the offer already runs: the source day has none, the target day two.
      await store.saveOccurrenceOverride(ownerA, "tea", "sample-am", { kind: "RESCHEDULE", occurrenceId: occurrenceIdFor("sample-am", day(6)), localDate: day(7), localStartTime: "16:00" }, null, randomUUID());
      availability = await list();
      const moved = occurrence(availability.occurrences, "sample-am", day(5));
      assert.equal(moved?.startAt, tokyoLocalToUtc(day(5), "15:00"));
      assert.equal(moved?.bookable, true);
      const heldMoved = await guests.startGuestBooking(request({ occurrenceDate: day(5), guestEmail: "moved@example.com" }));
      assert.equal(heldMoved.booking.occurrenceId, occurrenceIdFor("sample-am", day(5)));
      assert.equal(heldMoved.booking.occurrenceSnapshot.localStartTime, "15:00");
      assert.equal(occurrence(availability.occurrences, "sample-am", day(6)), undefined);
      const doubled = availability.occurrences.filter((item) => item.offerId === "sample-am" && item.date === day(7));
      assert.deepEqual(doubled.map(state), [{ bookable: false, seatsLeft: 0, reason: "UNAVAILABLE" }, { bookable: false, seatsLeft: 0, reason: "UNAVAILABLE" }]);
      await refused(guests.startGuestBooking(request({ occurrenceDate: day(6), guestEmail: "other@example.com" })), "OCCURRENCE_INVALID", { occurrenceReason: "NOT_SCHEDULED" });
      await refused(guests.startGuestBooking(request({ occurrenceDate: day(7), guestEmail: "other@example.com" })), "OCCURRENCE_INVALID", { occurrenceReason: "UNAVAILABLE" });
      // Not scheduled: before the rule starts, in the past, or past the public window.
      for (const date of [day(0), day(-3), day(90), day(120)]) {
        await refused(guests.startGuestBooking(request({ occurrenceDate: date, guestEmail: "other@example.com" })), "OCCURRENCE_INVALID", { occurrenceReason: "NOT_SCHEDULED" });
      }

      // Google blocking without a fresh sync stops the whole experience; a fresh busy time stops one occurrence.
      await store.configureGoogleCalendar(ownerA, { opaqueCalendarId: "sample-calendar", blockingEnabled: true }, null);
      availability = await list();
      assert.deepEqual(state(occurrence(availability.occurrences, "sample-am", day(8))), { bookable: false, seatsLeft: 0, reason: "UNAVAILABLE" });
      assert.deepEqual(state(occurrence(availability.occurrences, "sample-am", day(2))), { bookable: false, seatsLeft: 0, reason: "FULL" });
      assert.ok(availability.occurrences.every((item) => !item.bookable));
      const stale = await refused(guests.startGuestBooking(request({ occurrenceDate: day(8), guestEmail: "other@example.com" })), "UNAVAILABLE", { occurrenceReason: null });
      assert.equal(stale.retryable, false);
      const now = Date.now();
      await store.recordGoogleBusySync({ providerId: "provider-a" }, {
        opaqueCalendarId: "sample-calendar", attemptedAtUtc: new Date(now - 1_000).toISOString(), freshUntilUtc: new Date(now + 600_000).toISOString(),
        coverageStartUtc: new Date(now - 86_400_000).toISOString(), coverageEndUtc: new Date(now + 100 * 86_400_000).toISOString(),
        busyIntervals: [{ startUtc: tokyoLocalToUtc(day(8), "10:30"), endUtc: tokyoLocalToUtc(day(8), "11:00") }],
      });
      availability = await list();
      assert.deepEqual(state(occurrence(availability.occurrences, "sample-am", day(8))), { bookable: false, seatsLeft: 0, reason: "UNAVAILABLE" });
      assert.deepEqual(state(occurrence(availability.occurrences, "sample-am", day(9))), { bookable: true, seatsLeft: 2, reason: null });
      await refused(guests.startGuestBooking(request({ occurrenceDate: day(8), guestEmail: "other@example.com" })), "OCCURRENCE_INVALID", { occurrenceReason: "UNAVAILABLE" });
      assert.equal((await guests.startGuestBooking(request({ occurrenceDate: day(9), guestEmail: "other@example.com" }))).status, "HOLD");

      // Availability counts for a party of the minimum size: one seat left is full for parties of two.
      await guests.setSaleTerms(ownerA, "tea", { ...TEA_TERMS, minimumParticipants: 2 }, 1);
      availability = await list();
      assert.deepEqual(state(occurrence(availability.occurrences, "sample-am", day(3))), { bookable: false, seatsLeft: 1, reason: "FULL" });
      assert.deepEqual(state(occurrence(availability.occurrences, "sample-am", day(9))), { bookable: false, seatsLeft: 1, reason: "FULL" });
      assert.deepEqual(state(occurrence(availability.occurrences, "sample-am", day(10))), { bookable: true, seatsLeft: 2, reason: null });
    });
  });

  it("refuses a request with NIHO's checkout codes and fields", async () => {
    await withSchema(async ({ pool, guests, addRule }) => {
      await addRule("tea", rule("sample-am"));
      await addRule("walk", rule("sample-walk-am"));
      await addRule("kids", rule("sample-kids-am"));

      const inputs: [Partial<StartGuestBookingInput>, string][] = [
        [{ guestName: "  " }, "guestName"],
        [{ guestName: "x".repeat(101) }, "guestName"],
        [{ guestEmail: "not-an-address" }, "guestEmail"],
        [{ guestEmail: `${"x".repeat(250)}@example.com` }, "guestEmail"],
        [{ guestPhone: "12" }, "guestPhone"],
        [{ guestPhone: "+81 90 1234 5678 ext" }, "guestPhone"],
        [{ guestPhone: "81+90 1234 5678" }, "guestPhone"],
        [{ note: "x".repeat(501) }, "note"],
        [{ note: "bell\u0007" }, "note"],
        [{ utm: { utmSource: "Newsletter" } }, "utmSource"],
        [{ utm: { utmContent: "x".repeat(65) } }, "utmContent"],
        [{ clientRequestKey: "short" }, "clientRequestKey"],
        [{ adultCount: -1 }, "adultCount"],
        [{ childCount: 1.5 }, "childCount"],
        [{ adultCount: 501 }, "adultCount"],
        [{ offerId: "not an id" }, "offerId"],
        [{ offerId: "sample-unknown" }, "offerId"],
        [{ offerId: "sample-walk-am" }, "offerId"],
        [{ occurrenceDate: "2026-02-30" }, "occurrenceDate"],
        [{ occurrenceDate: "tomorrow" }, "occurrenceDate"],
        [{ expectedTotalYen: -1 }, "expectedTotalYen"],
        [{ termsConsentVersion: "" }, "consent.agreedVersion"],
        [{ guestLanguage: "FR" as never }, "guestLanguage"],
        [{ conditionsConsentVersion: "" }, "conditionsConsent"],
        // The experience has conditions: consent is required.
        [{ conditionsConsentVersion: null }, "conditionsConsent"],
        // Party rules: an adult is required here, at most 6 people, at least 1.
        [{ adultCount: 0, childCount: 2, expectedTotalYen: 4000 }, "adultCount"],
        [{ adultCount: 7, expectedTotalYen: 28_000 }, "adultCount"],
        [{ adultCount: 0, expectedTotalYen: 0 }, "adultCount"],
      ];
      for (const [overrides, field] of inputs) {
        await refused(guests.startGuestBooking(request(overrides)), "INPUT_INVALID", { field });
      }
      // No child price: no children.
      await refused(guests.startGuestBooking(walkRequest({ childCount: 1, expectedTotalYen: 3000 })), "INPUT_INVALID", { field: "childCount" });
      // Children without an adult where the experience allows it.
      const children = await guests.startGuestBooking(kidsRequest({ adultCount: 0, childCount: 2, expectedTotalYen: 3000 }));
      assert.equal(children.totalAmount, 3000);

      await refused(guests.startGuestBooking(request({ termsConsentVersion: "sample-terms-2026-09" })), "CONSENT_OUTDATED", { field: "consent.agreedVersion" });
      await refused(guests.startGuestBooking(request({ conditionsConsentVersion: "d1".repeat(32) })), "CONSENT_OUTDATED", { field: "conditionsConsent.version" });
      // Consent to conditions an experience no longer has is outdated as well.
      await refused(guests.startGuestBooking(walkRequest({ conditionsConsentVersion: CONDITIONS })), "CONSENT_OUTDATED", { field: "conditionsConsent.version" });

      await refused(guests.startGuestBooking(request({ expectedTotalYen: 3999 })), "PRICE_CHANGED", { currentTotalYen: 4000 });
      await refused(guests.startGuestBooking(request({ childCount: 1, expectedTotalYen: 4000 })), "PRICE_CHANGED", { currentTotalYen: 6000 });
      await refused(guests.startGuestBooking(request({ bookingQuestionsFingerprint: "0".repeat(64) })), "QUESTIONS_CHANGED", { questionId: null });
      await refused(guests.startGuestBooking(request({ answers: [] })), "QUESTIONS_CHANGED", { questionId: "diet" });
      await refused(guests.startGuestBooking(request({ answers: [{ questionId: "diet", optionIds: [] }] })), "ANSWERS_INVALID", { questionId: "diet", field: "optionIds" });

      const diet = { questionId: "diet", optionIds: ["veg"] };
      const answers: [NonNullable<StartGuestBookingInput["answers"]>, string | null, string][] = [
        [[diet, { questionId: "nope", text: "x" }], "nope", "questionId"],
        [[diet, diet], "diet", "questionId"],
        [[{ questionId: "diet", optionIds: ["veg", "none"] }], "diet", "optionIds"],
        [[{ questionId: "diet", optionIds: ["fish"] }], "diet", "optionIds"],
        [[{ questionId: "diet", text: "veg" }], "diet", "text"],
        [[diet, { questionId: "interests", optionIds: ["tea", "tea"] }], "interests", "optionIds"],
        [[diet, { questionId: "arrival", optionIds: ["veg"] }], "arrival", "optionIds"],
        [[diet, { questionId: "arrival", text: "x".repeat(201) }], "arrival", "text"],
        [[diet, { questionId: "story", text: "x".repeat(1001) }], "story", "text"],
        [[diet, { questionId: "story", text: "bell\u0007" }], "story", "text"],
        [[{ questionId: "diet", text: "veg", optionIds: ["veg"] }], "diet", "answer"],
        [[{ questionId: "bad id!" }], null, "questionId"],
        [Array.from({ length: 6 }, () => diet), null, "answers"],
      ];
      for (const [value, questionId, field] of answers) {
        await refused(guests.startGuestBooking(request({ answers: value })), "ANSWERS_INVALID", { questionId, field });
      }
      // The longest answers fit.
      const long = await guests.startGuestBooking(request({
        answers: [diet, { questionId: "arrival", text: "x".repeat(200) }, { questionId: "story", text: "Line one\nline two ".repeat(50).slice(0, 1000) }, { questionId: "interests", optionIds: ["tea", "garden", "history"] }],
      }));
      assert.equal(long.status, "HOLD");

      // The web layer's own values are not the guest's mistakes.
      await assert.rejects(() => guests.startGuestBooking(request({ currentConsentVersion: "" })), StoreValidationError);
      await assert.rejects(() => guests.startGuestBooking(request({ holdSeconds: 30 })), StoreValidationError);

      // Nothing refused left a booking behind; error messages carry no personal data.
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM bookings")).rows[0].n, 2);
      const error = await refused(guests.startGuestBooking(request({ guestName: "Secret Sample", guestEmail: "secret@example.com", expectedTotalYen: 1 })), "PRICE_CHANGED");
      assert.doesNotMatch(`${error.message} ${error.stack ?? ""}`, /secret/i);
    });
  });

  it("returns the same booking for the same request and refuses other content under its key", async () => {
    await withSchema(async ({ pool, store, guests, addRule }) => {
      await addRule("tea", rule("sample-am"));
      await addRule("walk", rule("sample-walk-am"));
      const key = randomUUID();
      const first = await guests.startGuestBooking(request({ clientRequestKey: key, guestPhone: " +81 90  1234 5678 ", guestName: " Sample \n Guest ", utm: { utmSource: "newsletter" } }));
      const again = await guests.startGuestBooking(request({ clientRequestKey: key, guestPhone: "+81 90 1234 5678", utm: { utmSource: "newsletter" } }));
      assert.deepEqual(again, first);
      assert.equal(first.checkoutSessionRef, null);

      for (const changed of [
        { adultCount: 2, expectedTotalYen: 8000 },
        { guestName: "Other Guest" },
        { guestEmail: "other@example.com" },
        { note: "Window seat" },
        { occurrenceDate: day(4) },
        { utm: {} },
        { guestLanguage: "JA" as const },
        { answers: [{ questionId: "diet", optionIds: ["none"] }] },
      ] satisfies Partial<StartGuestBookingInput>[]) {
        await refused(guests.startGuestBooking(request({ clientRequestKey: key, guestPhone: "+81 90 1234 5678", utm: { utmSource: "newsletter" }, ...changed })), "REQUEST_MISMATCH");
      }
      const same = request({ clientRequestKey: key, guestPhone: "+81 90 1234 5678", utm: { utmSource: "newsletter" } });

      // A retry gets the booking it already made even after the price, the site's consent version or the seats changed.
      await pool.query("UPDATE experience_products SET unit_amount=5000 WHERE id='tea'");
      await store.setOccurrenceSalesState(ownerA, "tea", "sample-am", { occurrenceId: occurrenceIdFor("sample-am", day(2)), desiredState: "CLOSED" }, null, randomUUID());
      assert.equal((await guests.startGuestBooking({ ...same, currentConsentVersion: "sample-terms-2026-11" })).publicBookingId, first.publicBookingId);

      await guests.attachCheckoutSession(first.publicBookingId, "cs_test_sample1");
      assert.equal((await guests.startGuestBooking(same)).checkoutSessionRef, "cs_test_sample1");
      await payFor(store, first, 4000, "replay");
      const paid = await guests.startGuestBooking(same);
      assert.equal(paid.status, "CONFIRMED");
      assert.equal(paid.publicBookingId, first.publicBookingId);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM bookings")).rows[0].n, 1);

      // A key is per experience: the same key for the walk is a new booking.
      const walk = await guests.startGuestBooking(walkRequest({ clientRequestKey: key }));
      assert.notEqual(walk.publicBookingId, first.publicBookingId);
      // A plain hold under the guest key prefix is not a guest's request.
      const plainKey = randomUUID();
      await store.createBookingHold({ providerId: "provider-a" }, { productId: "walk", occurrenceId: occurrenceIdFor("sample-walk-am", day(2)), seats: 1, idempotencyKey: `guest-checkout:walk:${plainKey}` });
      await refused(guests.startGuestBooking(walkRequest({ clientRequestKey: plainKey })), "REQUEST_MISMATCH");
    });
  });

  it("limits active holds per guest and experience, and new bookings per guest an hour", async () => {
    await withSchema(async ({ pool, guests, addRule }) => {
      await addRule("tea", rule("sample-am"));
      await addRule("walk", rule("sample-walk-am"));
      await addRule("kids", rule("sample-kids-am"));

      await guests.startGuestBooking(request({ occurrenceDate: day(2) }));
      await guests.startGuestBooking(request({ occurrenceDate: day(3), guestEmail: "GUEST@example.com" }));
      await refused(guests.startGuestBooking(request({ occurrenceDate: day(4), guestEmail: " Guest@Example.com " })), "HOLD_LIMIT");
      // Each experience counts on its own; five new bookings an hour per address and provider.
      await guests.startGuestBooking(walkRequest({ occurrenceDate: day(2) }));
      await guests.startGuestBooking(walkRequest({ occurrenceDate: day(3) }));
      await guests.startGuestBooking(kidsRequest({ occurrenceDate: day(2) }));
      const limited = await refused(guests.startGuestBooking(kidsRequest({ occurrenceDate: day(3) })), "RATE_LIMITED");
      assert.equal(limited.retryable, true);
      assert.ok(limited.retryAfterSeconds !== null && limited.retryAfterSeconds >= 1 && limited.retryAfterSeconds <= 3600);
      assert.equal((await guests.startGuestBooking(kidsRequest({ occurrenceDate: day(3), guestEmail: "friend@example.com" }))).status, "HOLD");

      // An hour later the address may start bookings again, but its two tea holds are still active.
      await pool.query("ALTER TABLE booking_guests DISABLE TRIGGER booking_guests_protect");
      await pool.query("UPDATE booking_guests SET created_at = created_at - interval '61 minutes'");
      await pool.query("ALTER TABLE booking_guests ENABLE TRIGGER booking_guests_protect");
      assert.equal((await guests.startGuestBooking(kidsRequest({ occurrenceDate: day(3) }))).status, "HOLD");
      await refused(guests.startGuestBooking(request({ occurrenceDate: day(5) })), "HOLD_LIMIT");
      // An expired hold no longer counts.
      await pool.query("ALTER TABLE bookings DISABLE TRIGGER bookings_protect_snapshots");
      await pool.query(
        `UPDATE bookings SET created_at=clock_timestamp()-interval '40 minutes', hold_expires_at=clock_timestamp()-interval '5 minutes'
          WHERE product_id='tea' AND occurrence_id=$1`,
        [occurrenceIdFor("sample-am", day(2))],
      );
      await pool.query("ALTER TABLE bookings ENABLE TRIGGER bookings_protect_snapshots");
      assert.equal((await guests.startGuestBooking(request({ occurrenceDate: day(5) }))).status, "HOLD");

      // Thirty active holds per experience, whoever holds them.
      const active = async () => Number((await pool.query(
        "SELECT count(*)::int AS n FROM bookings WHERE product_id='tea' AND status='HOLD' AND hold_expires_at > clock_timestamp()",
      )).rows[0].n);
      for (let index = await active(); index < 30; index += 1) {
        await guests.startGuestBooking(request({ occurrenceDate: day(10 + Math.floor(index / 5)), guestEmail: `guest-${index}@example.com` }));
      }
      assert.equal(await active(), 30);
      await refused(guests.startGuestBooking(request({ occurrenceDate: day(20), guestEmail: "late@example.com" })), "HOLD_LIMIT");
      assert.equal((await guests.startGuestBooking(walkRequest({ occurrenceDate: day(20), guestEmail: "late@example.com" }))).status, "HOLD");
    });
  });

  it("prices children apart, snapshots the breakdown, and confirms payment against the snapshot total", async () => {
    await withSchema(async ({ pool, store, guests, addRule }) => {
      await addRule("tea", rule("sample-am"));
      await addRule("kids", rule("sample-kids-am"));
      const family = await guests.startGuestBooking(request({
        adultCount: 2, childCount: 1, expectedTotalYen: 10_000, guestName: "Sample Parent", guestEmail: "Parent@Example.com",
        guestPhone: "+81 90 1234 5678", guestLanguage: "JA", note: "  Celebrating a birthday  ", utm: { utmSource: "newsletter", utmCampaign: "autumn" },
        answers: [
          { questionId: "diet", optionIds: ["veg"] },
          { questionId: "arrival", text: "  Kamakura  " },
          { questionId: "story", text: "   " },
          { questionId: "interests", optionIds: [] },
        ],
      }));
      assert.deepEqual(
        { ...family, booking: undefined, holdExpiresAt: undefined, publicBookingId: undefined },
        {
          publicBookingId: undefined, status: "HOLD", holdExpiresAt: undefined, totalAmount: 10_000, currency: "JPY",
          stripeConnectAccountRef: "acct_SampleA0001", sellerDisplayName: "Sample Seller A", productTitle: "Synthetic tea ceremony",
          guestEmail: "Parent@Example.com", checkoutSessionRef: null, booking: undefined,
        },
      );
      assert.equal(family.booking.seats, 3);
      assert.equal(family.holdExpiresAt, family.booking.holdExpiresAtUtc);
      // 35 minutes: a Stripe Checkout Session (30 minutes at least, ended 60 s before the hold) still fits
      // when it is created minutes after the hold.
      const holdMilliseconds = Date.parse(family.holdExpiresAt) - Date.parse(family.booking.createdAtUtc);
      assert.ok(Math.abs(holdMilliseconds - 2_100_000) <= 5, String(holdMilliseconds));
      assert.ok(holdMilliseconds - (1_800_000 + 60_000) >= 180_000);
      assert.deepEqual(family.booking.pricingSnapshot, {
        currency: "JPY", unitAmount: 4000, seats: 3, totalAmount: 10_000, cancellationTermsRef: "terms-v1",
        breakdown: { adultCount: 2, childCount: 1, childUnitAmount: 2000 }, cancellationPolicy: "FREE_UNTIL_24H",
      });
      assert.equal(family.booking.occurrenceSnapshot.seats, 3);
      const stored = await pool.query(
        `SELECT guest_name, guest_email, guest_email_key, guest_phone, guest_language, note, answers, adult_count, child_count,
                terms_consent_version, conditions_consent_version, utm, checkout_session_ref, pii_erased_at
           FROM booking_guests`,
      );
      assert.deepEqual(stored.rows, [{
        guest_name: "Sample Parent", guest_email: "Parent@Example.com", guest_email_key: "parent@example.com", guest_phone: "+81 90 1234 5678",
        guest_language: "JA", note: "Celebrating a birthday",
        answers: [{ questionId: "diet", optionIds: ["veg"] }, { questionId: "arrival", text: "Kamakura" }],
        adult_count: 2, child_count: 1, terms_consent_version: CONSENT, conditions_consent_version: CONDITIONS,
        utm: { utmSource: "newsletter", utmCampaign: "autumn" }, checkout_session_ref: null, pii_erased_at: null,
      }]);

      const children = await guests.startGuestBooking(kidsRequest({ adultCount: 0, childCount: 2, expectedTotalYen: 3000 }));
      assert.deepEqual(children.booking.pricingSnapshot, {
        currency: "JPY", unitAmount: 2500, seats: 2, totalAmount: 3000, cancellationTermsRef: "terms-v1",
        breakdown: { adultCount: 0, childCount: 2, childUnitAmount: 1500 }, cancellationPolicy: "FREE_UNTIL_48H",
      });

      // The webhook compares the charge with the snapshot total, not unit price × seats.
      const confirmed = await payFor(store, family, 10_000, "family");
      assert.equal(confirmed.booking.status, "CONFIRMED");
      const ledger = await pool.query("SELECT amount::int AS amount FROM payment_ledger_entries WHERE stripe_event_id='evt_sample_family'");
      assert.equal(ledger.rows[0].amount, 10_000);
      const other = await guests.startGuestBooking(request({ childCount: 1, expectedTotalYen: 6000, guestEmail: "other@example.com" }));
      assert.equal((await payFor(store, other, 8000, "unit-times-seats")).booking.status, "PAYMENT_REVIEW");
      assert.equal((await payFor(store, children, 3000, "children")).booking.status, "CONFIRMED");

      // Outbox and calendar events carry IDs only.
      const events = await pool.query("SELECT payload FROM outbox_messages UNION ALL SELECT payload FROM calendar_outbox_events");
      assert.ok(events.rows.length > 0);
      assert.doesNotMatch(JSON.stringify(events.rows), /example\.com|Sample Parent|Sample Guest|birthday|Kamakura|\+81|newsletter/i);
    });
  });

  it("attaches one Checkout Session to an active guest hold", async () => {
    await withSchema(async ({ pool, store, guests, addRule }) => {
      await addRule("tea", rule("sample-am"));
      const held = await guests.startGuestBooking(request());
      await guests.attachCheckoutSession(held.publicBookingId, "cs_test_sample1");
      await guests.attachCheckoutSession(held.publicBookingId.toUpperCase(), "cs_test_sample1");
      await assert.rejects(() => guests.attachCheckoutSession(held.publicBookingId, "cs_test_sample2"), StoreConflictError);
      assert.deepEqual((await pool.query("SELECT checkout_session_ref FROM booking_guests")).rows, [{ checkout_session_ref: "cs_test_sample1" }]);
      // The database keeps it set once as well.
      await assert.rejects(() => pool.query("UPDATE booking_guests SET checkout_session_ref='cs_other'"), /set once/);
      await assert.rejects(() => pool.query("UPDATE booking_guests SET adult_count=2"), /immutable/);
      await assert.rejects(() => pool.query("UPDATE booking_guests SET guest_name='Changed'"), /only by erasure/);

      await assert.rejects(() => guests.attachCheckoutSession(randomUUID(), "cs_test_sample3"), StoreNotFoundError);
      await assert.rejects(() => guests.attachCheckoutSession("not-a-uuid", "cs_test_sample3"), StoreValidationError);
      await assert.rejects(() => guests.attachCheckoutSession(held.publicBookingId, "cs bad"), StoreValidationError);
      // A hold made without a guest record is not a guest booking.
      const plain = await store.createBookingHold({ providerId: "provider-a" }, { productId: "tea", occurrenceId: occurrenceIdFor("sample-am", day(3)), seats: 1, idempotencyKey: "sample-plain" });
      await assert.rejects(() => guests.attachCheckoutSession(plain.publicBookingId, "cs_test_sample3"), StoreNotFoundError);
      // Paid, or no longer held: too late for a session.
      const paid = await guests.startGuestBooking(request({ guestEmail: "paid@example.com" }));
      await payFor(store, paid, 4000, "paid");
      await assert.rejects(() => guests.attachCheckoutSession(paid.publicBookingId, "cs_test_sample4"), StoreConflictError);
      const late = await guests.startGuestBooking(request({ guestEmail: "late@example.com" }));
      await pool.query("ALTER TABLE bookings DISABLE TRIGGER bookings_protect_snapshots");
      await pool.query("UPDATE bookings SET created_at=clock_timestamp()-interval '40 minutes', hold_expires_at=clock_timestamp()-interval '1 minute' WHERE public_booking_id=$1", [late.publicBookingId]);
      await pool.query("ALTER TABLE bookings ENABLE TRIGGER bookings_protect_snapshots");
      await assert.rejects(() => guests.attachCheckoutSession(late.publicBookingId, "cs_test_sample5"), StoreConflictError);
    });
  });

  it("keeps the guest of a payment under review, and counts a cancelled booking from its cancellation", async () => {
    await withSchema(async ({ pool, guests, addRule }) => {
      await addRule("tea", rule("sample-am"));
      const review = await guests.startGuestBooking(request({ guestEmail: "review@example.com" }));
      const cancelled = await guests.startGuestBooking(request({ occurrenceDate: day(3), guestEmail: "cancelled@example.com" }));
      await pool.query("ALTER TABLE bookings DISABLE TRIGGER bookings_protect_snapshots");
      await pool.query(
        "UPDATE bookings SET status='PAYMENT_REVIEW', occurrence_snapshot = jsonb_set(occurrence_snapshot, '{endUtc}', to_jsonb('2020-01-01T01:30:00.000Z'::text)) WHERE public_booking_id=$1",
        [review.publicBookingId],
      );
      await pool.query("UPDATE bookings SET status='CANCELLED', cancelled_at=clock_timestamp()-interval '400 days' WHERE public_booking_id=$1", [cancelled.publicBookingId]);
      await pool.query("ALTER TABLE bookings ENABLE TRIGGER bookings_protect_snapshots");

      // A year ago: the review's occurrence ended long before, the cancellation 400 days ago.
      assert.equal(await guests.eraseGuestData({ endedBefore: new Date(Date.now() - 365 * 86_400_000).toISOString() }), 1);
      const rows = await pool.query(
        `SELECT b.public_booking_id::text AS id, g.pii_erased_at IS NOT NULL AS erased
           FROM booking_guests g JOIN bookings b ON b.provider_id=g.provider_id AND b.id=g.booking_id ORDER BY g.booking_id`,
      );
      assert.deepEqual(rows.rows, [{ id: review.publicBookingId, erased: false }, { id: cancelled.publicBookingId, erased: true }]);
    });
  });

  it("erases guest details of occurrences that have ended, once", async () => {
    await withSchema(async ({ pool, guests, addRule }) => {
      await addRule("tea", rule("sample-am"));
      const pastKey = randomUUID();
      const pastRequest = request({ clientRequestKey: pastKey, guestPhone: "+81 90 1234 5678", note: "Sample note", utm: { utmSource: "newsletter" } });
      const past = await guests.startGuestBooking(pastRequest);
      const upcoming = await guests.startGuestBooking(request({ occurrenceDate: day(3), guestEmail: "upcoming@example.com" }));

      // Nothing has ended yet; an instant in the future does not erase upcoming guests.
      assert.equal(await guests.eraseGuestData({ endedBefore: new Date(Date.now() + 365 * 86_400_000).toISOString() }), 0);
      await pool.query("ALTER TABLE bookings DISABLE TRIGGER bookings_protect_snapshots");
      await pool.query(
        "UPDATE bookings SET occurrence_snapshot = jsonb_set(occurrence_snapshot, '{endUtc}', to_jsonb('2020-01-01T01:30:00.000Z'::text)) WHERE public_booking_id=$1",
        [past.publicBookingId],
      );
      await pool.query("ALTER TABLE bookings ENABLE TRIGGER bookings_protect_snapshots");
      assert.equal(await guests.eraseGuestData({ endedBefore: "2019-12-31T00:00:00.000Z" }), 0);
      assert.equal(await guests.eraseGuestData({ endedBefore: new Date().toISOString() }), 1);
      assert.equal(await guests.eraseGuestData({ endedBefore: new Date().toISOString() }), 0);

      const rows = await pool.query(
        `SELECT b.public_booking_id::text AS id, g.guest_name, g.guest_email, g.guest_email_key, g.guest_phone, g.note, g.answers, g.utm,
                g.pii_erased_at IS NOT NULL AS erased, g.adult_count, g.terms_consent_version
           FROM booking_guests g JOIN bookings b ON b.provider_id=g.provider_id AND b.id=g.booking_id ORDER BY g.booking_id`,
      );
      assert.deepEqual(rows.rows[0], {
        id: past.publicBookingId, guest_name: null, guest_email: null, guest_email_key: null, guest_phone: null, note: null, answers: null, utm: null,
        erased: true, adult_count: 1, terms_consent_version: CONSENT,
      });
      assert.equal(rows.rows[1].id, upcoming.publicBookingId);
      assert.equal(rows.rows[1].guest_email, "upcoming@example.com");
      assert.equal(rows.rows[1].erased, false);
      // Erased stays erased.
      await assert.rejects(() => pool.query("UPDATE booking_guests SET pii_erased_at=NULL, guest_name='Sample Guest' WHERE pii_erased_at IS NOT NULL"), /stays erased/);
      // A retry of the erased booking's request still names it, without the address.
      const replay = await guests.startGuestBooking(pastRequest);
      assert.equal(replay.publicBookingId, past.publicBookingId);
      assert.equal(replay.guestEmail, null);

      await assert.rejects(() => guests.eraseGuestData({ endedBefore: "yesterday" }), StoreValidationError);
      await assert.rejects(() => guests.eraseGuestData({ endedBefore: new Date().toISOString(), limit: 0 }), StoreValidationError);
    });
  });
});
