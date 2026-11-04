import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { addLocalDays, type ScheduleRule } from "@niho-experience/experience-domain";
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- This server-side integration test exercises the selected host client.
import { createExperienceHostApiClient } from "@niho-experience/api-client/host";
import { ExperiencePublicationRepository } from "@niho-experience/experience-store";
import { GuestBookingRepository } from "@niho-experience/experience-store";
import { ExperienceStore } from "@niho-experience/experience-store";
import { SiteSaleRegistration } from "@niho-experience/experience-store/site-sale-registration";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const NIHO_USER_ID = "niho-user-contract-synthetic-330";
const EXPERIENCE_PROVIDER_ID = "experience-provider-contract-synthetic-330";
const LEGACY_PROVIDER_ID = "legacy-provider-contract-synthetic-330";
const CONNECT_ACCOUNT_ID = "acct_ContractSeller330";
const CONSENT_VERSION = "listing-contract-v1";
const SLUG = "synthetic-niho-contract-experience";

const mocks = vi.hoisted(() => ({
  config: {
    experienceHostPublicationApiEnabled: true,
    experiencePublicationsEnabled: true,
    guestBookingEnabled: true,
    apiMode: "http",
    experiencePublicationConsentVersion: "listing-contract-v1",
    siteUrl: "https://experience.example.test",
  },
  session: vi.fn(),
  accessTokenUsable: vi.fn(),
  selectedHostApiClient: vi.fn(),
  repository: undefined as unknown,
  clearSessionCookie: vi.fn(),
  bookingRepository: undefined as unknown,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: mocks.config }));
vi.mock("@/lib/host/session", () => ({ accessTokenUsable: mocks.accessTokenUsable }));
vi.mock("@/lib/host/server", () => ({
  readHostSession: mocks.session,
  selectedHostApiClient: mocks.selectedHostApiClient,
  noStoreJson: (body: unknown, status = 200) => Response.json(body, {
    status,
    headers: { "cache-control": "private, no-store", "x-robots-tag": "noindex, nofollow" },
  }),
  clearSessionCookie: mocks.clearSessionCookie,
}));
vi.mock("@/lib/experience/store-server", () => ({
  experiencePublicationRepository: () => mocks.repository,
  guestBookingRepository: () => mocks.bookingRepository,
}));

import { publicationHostBoundary } from "./publication-host-boundary";
import { publicationCollectionRequest, publicationRequest } from "./publication-http";
import { getSitePublicExperience } from "./site-publications";
import { sitePublicationCard, cancellationSummary } from "./site-card-model";

const content = {
  lead: "A synthetic Experience used to verify the NIHO v1 contract.",
  description: "A synthetic host creates a product, publishes it and accepts a booking.",
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
};

const saleTerms = {
  offerPrices: null,
  childPricing: null,
  minimumParticipants: 1,
  minimumChargeableParticipants: 2,
  maxPartySize: 6,
  cancellationPolicy: "CUSTOM",
  cancellationWindowMinutesBeforeStart: 90,
  cancellationRefundBasisPoints: 3_750,
  minimumAttendance: null,
  bookingQuestions: [],
  conditionsVersion: null,
};

async function isolatedSchema(run: (pool: import("pg").Pool) => Promise<void>) {
  const { Pool } = await import("pg");
  const schema = `host_contract_${randomUUID().replaceAll("-", "")}`;
  const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 8, options: `-c search_path=${schema}` });
  try {
    await pool.query(`CREATE SCHEMA "${schema}"`);
    const migrations = (await readdir(new URL("../../../../../packages/experience-store/migrations/", import.meta.url)))
      .filter((name) => /^\d{4}.*\.sql$/.test(name)).sort();
    for (const name of migrations) {
      await pool.query(await readFile(new URL(`../../../../../packages/experience-store/migrations/${name}`, import.meta.url), "utf8"));
    }
    await run(pool);
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
    await pool.end();
  }
}

describe("NIHO Host API v1 → Experience owner publication → booking (synthetic)", {
  skip: TEST_DATABASE_URL === undefined,
}, () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(mocks.config, {
      experiencePublicationsEnabled: true,
      guestBookingEnabled: true,
      apiMode: "http",
      experienceHostPublicationApiEnabled: true,
      experiencePublicationConsentVersion: CONSENT_VERSION,
      siteUrl: "https://experience.example.test",
    });
    mocks.session.mockResolvedValue({ accessToken: "synthetic-niho-session-bearer" });
    mocks.accessTokenUsable.mockReturnValue(true);
    mocks.bookingRepository = undefined;
  });
  afterEach(() => vi.unstubAllEnvs());

  it("uses only NIHO v1 identity/Connect, binds Experience OWNER, publishes and admits a booking", async () => {
    await isolatedSchema(async (pool) => {
      const registration = new SiteSaleRegistration(pool);
      const publicationRepository = new ExperiencePublicationRepository(pool);
      const experienceStore = new ExperienceStore(pool);
      const bookingRepository = new GuestBookingRepository(pool);
      mocks.bookingRepository = bookingRepository;
      const stripe = await registration.provisionHostSeller({
        providerId: EXPERIENCE_PROVIDER_ID,
        legacyProviderId: LEGACY_PROVIDER_ID,
        providerDisplayName: "Synthetic Experience seller workspace",
        sellerNihoAccountRef: NIHO_USER_ID,
        stripeConnectAccountRef: CONNECT_ACCOUNT_ID,
        sellerDisplayName: "Synthetic legal seller",
        supportEnabled: false,
      });
      expect(stripe).toEqual({ provider: "CREATED", sellerProfile: "CREATED", saleSettings: "CREATED" });
      mocks.repository = publicationRepository;

      const contractRequests: { url: string; authorization: string | null; service: string | null }[] = [];
      const client = createExperienceHostApiClient({
        nihoWebOrigin: "https://niho.example.test",
        accessToken: "synthetic-niho-session-bearer",
        serviceIdToken: "synthetic-experience-service-id-token",
        fetch: async (input, init) => {
          const url = new URL(String(input));
          const headers = new Headers(init?.headers);
          contractRequests.push({
            url: `${url.pathname}${url.search}`,
            authorization: headers.get("authorization"),
            service: headers.get("x-niho-experience-service-id-token"),
          });
          const payload = url.pathname === "/api/experience-host/identity"
            ? { nihoUserId: NIHO_USER_ID, accountStatus: "ACTIVE" }
            : url.pathname === `/api/experience-host/legacy-providers/${LEGACY_PROVIDER_ID}/connect-account`
              ? {
                legacyProviderId: LEGACY_PROVIDER_ID,
                stripeAccountId: CONNECT_ACCOUNT_ID,
                readiness: { ready: true, reason: "READY" },
                paymentReuseConsent: { accepted: true, version: "payment-reuse-v4", consentedAt: "2026-11-03T11:30:00.000Z" },
              }
              : null;
          return payload === null
            ? Response.json({ error: "not_found" }, { status: 404 })
            : Response.json(payload, { status: 200, headers: { "content-type": "application/json" } });
        },
      });
      mocks.selectedHostApiClient.mockResolvedValue(client);

      const boundary = await publicationHostBoundary("OWNER");
      expect(boundary.ok).toBe(true);
      if (!boundary.ok) return;
      expect(boundary.value.actor).toEqual({ providerId: EXPERIENCE_PROVIDER_ID, nihoUserId: NIHO_USER_ID });
      expect(boundary.value.readiness).toMatchObject({
        accountUsable: true,
        connectReady: true,
        paymentReuseConsentAccepted: true,
        paymentReuseConsentVersion: "payment-reuse-v4",
        sellerNihoAccountRef: NIHO_USER_ID,
        stripeConnectAccountRef: CONNECT_ACCOUNT_ID,
      });
      expect(await pool.query("SELECT role,active FROM provider_memberships WHERE provider_id=$1 AND niho_user_id=$2", [EXPERIENCE_PROVIDER_ID, NIHO_USER_ID]))
        .toMatchObject({ rows: [{ role: "OWNER", active: true }] });

      const createResponse = await publicationCollectionRequest(new Request("https://experience.example.test/host/api/products", {
        method: "POST",
        headers: {
          origin: "https://experience.example.test", "sec-fetch-site": "same-origin", "content-type": "application/json",
        },
        body: JSON.stringify({ slug: SLUG, publicTitle: "Synthetic contract experience", content, currency: "JPY", unitAmount: 4_000 }),
      }), "create");
      expect(createResponse.status).toBe(201);
      const created = await createResponse.json() as { product: { id: string; version: string; draft: { version?: number } } };
      const productId = created.product.id;
      expect(productId).toMatch(/^[0-9a-f-]{36}$/i);
      expect(await publicationRepository.listClaimedSlugs()).toEqual([SLUG]);

      await publicationRepository.addMedia(boundary.value.actor, productId, {
        id: randomUUID(), objectKey: `experience-products/${randomUUID()}.jpg`, sourceRefHash: "a".repeat(64),
        width: 640, height: 480, byteSize: 2048, altText: "Synthetic photo", publicCredit: null,
      });
      const occurrenceDay = addLocalDays(new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10), 1);
      const rule: ScheduleRule = {
        id: "contract-synthetic-daily", timeZone: "Asia/Tokyo", startsOn: occurrenceDay, endsOn: occurrenceDay,
        localStartTime: "10:00", durationMinutes: 90, capacity: 4, bookingCutoffMinutes: 0,
        busyBufferBeforeMinutes: 0, busyBufferAfterMinutes: 0, recurrence: { kind: "DAILY" },
      };
      await experienceStore.saveScheduleRule(boundary.value.actor, productId, rule, null, randomUUID());

      const readResponse = await publicationRequest(
        new Request(`https://experience.example.test/host/api/products/${productId}`, { method: "GET" }),
        { params: Promise.resolve({ productId }) }, "read",
      );
      expect(readResponse.status).toBe(200);
      const readBody = await readResponse.json() as { product: { version: string } };
      const termsResponse = await publicationRequest(
        new Request(`https://experience.example.test/host/api/products/${productId}/sale-terms`, {
          method: "PUT",
          headers: {
            origin: "https://experience.example.test", "sec-fetch-site": "same-origin", "content-type": "application/json",
          },
          body: JSON.stringify({ version: readBody.product.version, saleTerms }),
        }),
        { params: Promise.resolve({ productId }) }, "saveSaleTerms",
      );
      expect(termsResponse.status).toBe(200);
      const termsBody = await termsResponse.json() as { product: { version: string } };
      const publishResponse = await publicationRequest(
        new Request(`https://experience.example.test/host/api/products/${productId}/publish`, {
          method: "POST",
          headers: {
            origin: "https://experience.example.test", "sec-fetch-site": "same-origin", "content-type": "application/json",
          },
          body: JSON.stringify({ version: termsBody.product.version, consentVersion: CONSENT_VERSION, accepted: true }),
        }),
        { params: Promise.resolve({ productId }) }, "publish",
      );
      expect(publishResponse.status).toBe(200);
      expect((await publishResponse.json() as { product: { status: string } }).product.status).toBe("PUBLISHED");

      expect((await publicationRepository.getPublicBySlug(SLUG))?.sellerDisplayName).toBe("Synthetic legal seller");
      const terms = await bookingRepository.publicBookingTerms(SLUG);
      expect(terms?.sellerDisplayName).toBe("Synthetic legal seller");
      expect(terms?.offers).toHaveLength(1);
      const siteProduct = await getSitePublicExperience(SLUG);
      expect(siteProduct?.kind).toBe("published");
      if (siteProduct?.kind !== "published") throw new Error("Synthetic publication was not readable.");
      expect(siteProduct.item.publication.publicTitle).toBe("Synthetic contract experience");
      expect(siteProduct.item.saleTerms).not.toHaveProperty("providerId");
      expect(siteProduct.item.saleTerms).not.toHaveProperty("productId");
      expect(siteProduct.item.saleTerms?.offers[0]?.cancellationPolicy.code).toBe("CUSTOM");
      expect(siteProduct.item.saleTerms?.offers[0]?.minimumChargeableParticipants).toBe(2);
      const card = sitePublicationCard(siteProduct.item);
      expect(card).toMatchObject({ slug: SLUG, title: "Synthetic contract experience", priceLabel: "¥4,000", offers: [{ id: rule.id, minimumParticipants: 1, maxPartySize: 6 }] });
      expect(cancellationSummary(siteProduct.item.saleTerms!.offers[0]!)).toBe("37.5% refund when cancelled at least 90 minutes before the start");
      const fingerprint = createHash("sha256").update("[]", "utf8").digest("hex");
      const booking = await bookingRepository.startGuestBooking({
        slug: SLUG, offerId: rule.id, occurrenceDate: occurrenceDay, adultCount: 1, childCount: 0, expectedTotalYen: 8_000,
        bookingQuestionsFingerprint: fingerprint, termsConsentVersion: "synthetic-site-terms-v1",
        currentConsentVersion: "synthetic-site-terms-v1", conditionsConsentVersion: null,
        guestName: "Synthetic Guest", guestEmail: "guest@example.test", guestLanguage: "EN",
        clientRequestKey: `synthetic-contract-${randomUUID()}`,
      });
      expect(booking.status).toBe("HOLD");
      expect(contractRequests.map((request) => request.url)).toContain("/api/experience-host/identity");
      expect(contractRequests.map((request) => request.url)).toContain(`/api/experience-host/legacy-providers/${LEGACY_PROVIDER_ID}/connect-account`);
      expect(contractRequests.every((request) => request.authorization === "Bearer synthetic-niho-session-bearer"
        && request.service === "synthetic-experience-service-id-token")).toBe(true);
      expect(JSON.stringify(created).includes(CONNECT_ACCOUNT_ID)).toBe(false);
    });
  });
});
