import { beforeEach, describe, expect, it, vi } from "vitest";
import { StoreNotFoundError } from "@niho-experience/experience-store";

/*
 * 1 人が 2 つのホストのオーナー (#709, Epic #700 §4): the host APIs the screens call act for the host named in `?providerId=`, and only
 * for it. The real routes, the real boundary and the real provider-context run against a fake store that keeps one set of rows per
 * host, so a call that reaches the wrong host's rows (or none) shows. Stripe is not involved: only membership-only, seller-only and
 * draft operations are exercised here (the readiness isolation is in publication-host-boundary.test.ts).
 */
const HOST = `hst_${"c".repeat(32)}`;
const A = "provider-a";
const B = "provider-b";
const PHOTO_A = "00000000-0000-4000-8000-0000000000a1";
const PHOTO_B = "00000000-0000-4000-8000-0000000000b1";

const mocks = vi.hoisted(() => ({
  config: { experienceHostPublicationApiEnabled: true, experiencePublicationConsentVersion: "listing-v1", experiencePayoutAccountConsentVersion: "payout-v1", siteUrl: "https://experience.example.test" },
  memberships: [] as Array<{ providerId: string; role: string; accountActive: boolean }>,
  db: {} as Record<string, { products: Array<Record<string, unknown>>; media: Array<Record<string, unknown>>; bio: Record<string, unknown>; disclosure: Record<string, unknown> | null }>,
  sellerLookups: [] as Array<[string, string | undefined]>,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: mocks.config }));
vi.mock("@/lib/host/session", () => ({ accessTokenUsable: () => true }));
vi.mock("@/lib/host/server", () => ({
  readHostSession: async () => ({ kind: "experience", hostAccountId: HOST, sessionRef: "0f8fad5b-d9cb-469f-a165-70867728950e" }),
  noStoreJson: (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "private, no-store" } }),
  clearSessionCookie: () => undefined,
  selectedHostApiClient: async () => { throw new Error("NIHO is never called for an Experience host account"); },
}));

vi.mock("@/lib/experience/store-server", () => {
  const rows = (actor: { providerId: string }) => mocks.db[actor.providerId]!;
  const product = (actor: { providerId: string }, id: string) => {
    const found = rows(actor).products.find((item) => item.id === id);
    if (!found) throw new StoreNotFoundError("Product");
    return found;
  };
  const repository = {
    listHostAccountMemberships: async (_account: string, only?: string) => mocks.memberships.filter((row) => only === undefined || row.providerId === only),
    providerHasSellerProfile: async () => false,
    currentHostAccountSellerProfile: async (account: string, only?: string) => {
      mocks.sellerLookups.push([account, only]);
      // Without a provider the store cannot choose between two owned hosts.
      if (only === undefined) return { kind: "ambiguous" };
      return { kind: "ready", hostAccountActive: true, profile: {
        providerId: only, legacyProviderId: null, providerDisplayName: `Host ${only}`, sellerNihoAccountRef: `sel_${only}`,
        stripeConnectAccountRef: `acct_${only}`, sellerDisplayName: `Seller ${only}`,
      } };
    },
    refreshReadiness: async () => ({}),
    listProducts: async (actor: { providerId: string }) => rows(actor).products,
    getProduct: async (actor: { providerId: string }, id: string) => product(actor, id),
    getState: async () => null,
    getSaleTerms: async () => ({ draftVersion: 1, stateVersion: null, saleTerms: null }),
    listMedia: async (actor: { providerId: string }, id: string) => { product(actor, id); return rows(actor).media; },
    hasPendingPublicationChanges: async () => false,
    listActiveSaleOffers: async () => [],
    getPublicationBlockers: async () => [],
    createDraft: async (actor: { providerId: string }, input: { slug: string; publicTitle: string }) => {
      const created = { id: `product-${actor.providerId}-${rows(actor).products.length + 1}`, version: 1, slug: input.slug, publicTitle: input.publicTitle, content: {}, currency: "JPY", unitAmount: 0, seller: null };
      rows(actor).products.push(created);
      return created;
    },
    getProviderMedia: async (actor: { providerId: string }) => ({ version: 1, assets: rows(actor).media.map((asset) => ({ ...asset, placement: "PROVIDER_PHOTO" })) }),
  };
  return {
    experiencePublicationRepository: () => repository,
    managedExperienceSalesRepository: () => ({ get: async () => null }),
    providerHostBioRepository: () => ({
      getForOwner: async (actor: { providerId: string }) => rows(actor).bio,
      save: async (actor: { providerId: string }, input: { bioJa: string }) => { rows(actor).bio = { version: 1, bioJa: input.bioJa, bioEn: null }; return rows(actor).bio; },
      withdraw: async () => ({}),
    }),
    providerSellerDisclosureRepository: () => ({
      getForOwner: async (actor: { providerId: string }) => ({ sellerDisplayName: `Seller ${actor.providerId}`, disclosure: rows(actor).disclosure }),
      save: async (actor: { providerId: string }, input: { disclosure: Record<string, unknown> }) => { rows(actor).disclosure = { ...input.disclosure, version: 1 }; return rows(actor).disclosure; },
      withdraw: async () => ({}),
    }),
    experienceStore: () => ({}),
    guestHoldReleases: () => ({}),
    guestMeetingGuideRepository: () => null,
    payoutAccountConsents: () => null,
  };
});

import { GET as listProducts, POST as createProduct } from "@/app/(host)/host/api/products/route";
import { GET as readProduct } from "@/app/(host)/host/api/products/[productId]/route";
import { GET as readProviderMedia } from "@/app/(host)/host/api/provider-media/route";
import { GET as readSeller, PUT as putSeller } from "@/app/(host)/host/api/seller/route";
import { GET as readBio, PUT as putBio } from "@/app/(host)/host/api/host-bio/route";
import { GET as readSalesPlan } from "@/app/(host)/host/api/products/[productId]/sales-plan/route";

const ORIGIN = "https://experience.example.test";
const call = (path: string, method = "GET", body?: unknown) => new Request(`${ORIGIN}${path}`, {
  method,
  headers: body === undefined ? undefined : { "content-type": "application/json", origin: ORIGIN, "sec-fetch-site": "same-origin" },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const idOf = (id: string) => ({ params: Promise.resolve({ productId: id }) });
const code = async (response: Response) => ((await response.json()) as { error?: { code?: string } }).error?.code;

const draft = { slug: "tea", publicTitle: "Tea", content: {}, currency: "JPY", unitAmount: 0 };
const disclosure = { method: "NATIVE", sellerKind: "PERSON", sellerDisplayName: "x", representativeName: null, publicAddress: "a", publicPhone: "p", publicEmail: "e@example.test", consentVersion: "seller-public-disclosure-v1", accepted: true };

beforeEach(() => {
  mocks.sellerLookups.length = 0;
  mocks.memberships = [{ providerId: A, role: "OWNER", accountActive: true }, { providerId: B, role: "OWNER", accountActive: true }];
  const row = (providerId: string, photo: string) => ({
    products: [{ id: `product-${providerId}-1`, version: 1, slug: `slug-${providerId}`, publicTitle: `Title ${providerId}`, content: {}, currency: "JPY", unitAmount: 0, seller: null }],
    media: [{ id: photo, position: 0, sourcePosition: 0, placement: "GALLERY", width: 1, height: 1, byteSize: 1, altText: "a", altTextJa: "あ" }],
    bio: { version: 0, bioJa: null, bioEn: null }, disclosure: null,
  });
  mocks.db = { [A]: row(A, PHOTO_A), [B]: row(B, PHOTO_B) };
});

describe("an owner of two hosts", () => {
  it("reads and writes only the host named by providerId", async () => {
    const titles = async (providerId: string) => ((await (await listProducts(call(`/host/api/products?providerId=${providerId}`))).json()).products as Array<{ draft: { publicTitle: string } }>).map((item) => item.draft.publicTitle);
    expect(await titles(A)).toEqual([`Title ${A}`]);
    expect(await titles(B)).toEqual([`Title ${B}`]);

    // A draft made for B is B's alone.
    const created = await createProduct(call(`/host/api/products?providerId=${B}`, "POST", draft));
    expect(created.status).toBe(201);
    expect(await titles(B)).toEqual([`Title ${B}`, "Tea"]);
    expect(await titles(A)).toEqual([`Title ${A}`]);

    // A product of one host is not found through the other.
    const own = await readProduct(call(`/host/api/products/product-${A}-1?providerId=${A}`), idOf(`product-${A}-1`));
    expect(own.status).toBe(200);
    const foreign = await readProduct(call(`/host/api/products/product-${A}-1?providerId=${B}`), idOf(`product-${A}-1`));
    expect(foreign.status).toBe(404);

    // Host introduction (ホスト紹介).
    expect((await putBio(call(`/host/api/host-bio?providerId=${B}`, "PUT", { bioJa: "Bの紹介", bioEn: null, expectedVersion: null, consentVersion: "host-bio-consent-v1" }))).status).toBe(200);
    expect((await (await readBio(call(`/host/api/host-bio?providerId=${B}`))).json()).hostBio.bioJa).toBe("Bの紹介");
    expect((await (await readBio(call(`/host/api/host-bio?providerId=${A}`))).json()).hostBio.bioJa).toBeNull();

    // 販売者表示 reads and writes the named host's seller, never an "ambiguous" one.
    expect((await putSeller(call(`/host/api/seller?providerId=${A}`, "PUT", { commandId: "123e4567-e89b-42d3-a456-426614174509", expectedVersion: null, disclosure }))).status).toBe(200);
    const sellerA = await (await readSeller(call(`/host/api/seller?providerId=${A}`))).json();
    const sellerB = await (await readSeller(call(`/host/api/seller?providerId=${B}`))).json();
    expect(sellerA.seller).toMatchObject({ sellerDisplayName: `Seller ${A}`, disclosure: { method: "NATIVE" } });
    expect(sellerB.seller).toEqual({ sellerDisplayName: `Seller ${B}`, disclosure: null });
    expect(mocks.sellerLookups.every(([account, only]) => account === HOST && (only === A || only === B))).toBe(true);

    // 販売プラン.
    const plan = await readSalesPlan(call(`/host/api/products/product-${B}-1/sales-plan?providerId=${B}`), idOf(`product-${B}-1`));
    expect(plan.status).toBe(200);
  });

  it("puts the host in every image URL, so the image loads without a 409", async () => {
    const providerMedia = await (await readProviderMedia(call(`/host/api/provider-media?providerId=${B}`))).json();
    expect(providerMedia.providerMedia.assets.map((asset: { previewUrl: string }) => asset.previewUrl)).toEqual([`/host/api/provider-media/${PHOTO_B}?providerId=${B}`]);
    const product = await (await readProduct(call(`/host/api/products/product-${A}-1?providerId=${A}`), idOf(`product-${A}-1`))).json();
    expect(product.product.media.map((asset: { previewUrl: string }) => asset.previewUrl)).toEqual([`/host/api/products/product-${A}-1/media/${PHOTO_A}?providerId=${A}`]);
    // The URL as given is accepted by the boundary (the provider is a member, checked again).
    const url = new URL(product.product.media[0].previewUrl, ORIGIN);
    expect(url.searchParams.get("providerId")).toBe(A);
  });

  it("asks which host (409) when none is named, on every host API", async () => {
    const answers = await Promise.all([
      listProducts(call("/host/api/products")),
      createProduct(call("/host/api/products", "POST", draft)),
      readProduct(call(`/host/api/products/product-${A}-1`), idOf(`product-${A}-1`)),
      readProviderMedia(call("/host/api/provider-media")),
      readSeller(call("/host/api/seller")),
      putSeller(call("/host/api/seller", "PUT", { commandId: "123e4567-e89b-42d3-a456-426614174509", expectedVersion: null, disclosure })),
      readBio(call("/host/api/host-bio")),
      putBio(call("/host/api/host-bio", "PUT", { bioJa: "x", bioEn: null, expectedVersion: null, consentVersion: "host-bio-consent-v1" })),
      readSalesPlan(call(`/host/api/products/product-${A}-1/sales-plan`), idOf(`product-${A}-1`)),
    ]);
    expect(answers.map((response) => response.status)).toEqual(answers.map(() => 409));
    expect(await Promise.all(answers.map(code))).toEqual(answers.map(() => "PROVIDER_REQUIRED"));
    expect(mocks.db[A]!.products).toHaveLength(1);
    expect(mocks.db[B]!.products).toHaveLength(1);
    expect(mocks.sellerLookups).toEqual([]);
  });

  it("refuses a host the account does not have (403) and an id that is not an id (422), host introduction included", async () => {
    mocks.memberships = [{ providerId: A, role: "OWNER", accountActive: true }, { providerId: B, role: "OWNER", accountActive: true }, { providerId: "provider-c", role: "COHOST", accountActive: true }];
    const request = (kind: string, query: string) => ({
      products: () => listProducts(call(`/host/api/products${query}`)),
      media: () => readProviderMedia(call(`/host/api/provider-media${query}`)),
      seller: () => readSeller(call(`/host/api/seller${query}`)),
      bio: () => readBio(call(`/host/api/host-bio${query}`)),
    } as Record<string, () => Promise<Response>>)[kind]!();
    for (const kind of ["products", "media", "seller", "bio"]) {
      expect((await request(kind, "?providerId=provider-unknown")).status, `${kind} unknown`).toBe(403);
      expect((await request(kind, "?providerId=provider-c")).status, `${kind} cohost`).toBe(403);
      for (const bad of ["?providerId=", "?providerId=a%20b", "?providerId=-x"]) {
        const response = await request(kind, bad);
        expect([response.status, await code(response)], `${kind} ${bad}`).toEqual([422, "INVALID_INPUT"]);
      }
    }
  });

  it("is unchanged for an owner of one host: with or without providerId", async () => {
    mocks.memberships = [{ providerId: A, role: "OWNER", accountActive: true }];
    for (const query of ["", `?providerId=${A}`]) {
      expect((await listProducts(call(`/host/api/products${query}`))).status).toBe(200);
      expect((await readBio(call(`/host/api/host-bio${query}`))).status).toBe(200);
    }
    expect(await code(await readBio(call(`/host/api/host-bio?providerId=${B}`)))).toBe("FORBIDDEN");
  });
});
