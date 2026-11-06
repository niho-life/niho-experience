import "server-only";
import { createHash, randomUUID } from "node:crypto";
import {
  DomainValidationError,
  assertLocalDate,
  expandOccurrences,
  localDateDistance,
  parseScheduleRule,
  type ScheduleRule,
} from "@niho-experience/experience-domain";
import {
  ExperiencePublicationBlockedError,
  StoreAccessDeniedError,
  StoreConflictError,
  StoreNotFoundError,
  StoreValidationError,
  validSaleTerms,
  type ExperienceHostMediaAssetInput,
  type ExperienceHostMediaSelectionInput,
  type ExperiencePublicationDraftCreateInput,
  type ExperiencePublicationDraftInput,
  type JsonValue,
  type ProductSaleTermsInput,
  type PublicationAdminDraftActor,
} from "@niho-experience/experience-store";
import { GuideCoverImageError, processGuideCoverImage, readGuideCoverInput } from "@/lib/editor/guide-cover-image";
import { experiencePublicMediaStorage } from "@/lib/experience/public-media-storage";
import { experiencePublicationRepository, experienceStore } from "@/lib/experience/store-server";
import { ResponseBodyTooLarge, readBoundedJson } from "@/lib/read-bounded-json";
import { config } from "@/lib/config";
import {
  adminJson as baseAdminJson,
  adminMutationAllowed,
  clearAdminHttpSessionCookie,
  isAdminHttp,
  loadAdminHttpSession,
} from "./server";

type RecordValue = Record<string, unknown>;
type Revision = { readonly draft: number; readonly state: number | null; readonly saleTerms: number | null };
type ProductContext = { params: Promise<{ providerId: string; productId: string }> };
type ProviderContext = { params: Promise<{ providerId: string }> };
type AssetContext = { params: Promise<{ providerId: string; productId: string; assetId: string }> };
type ProductDraftBody = {
  readonly slug: string;
  readonly publicTitle: string;
  readonly content: Readonly<Record<string, JsonValue>>;
  readonly currency: string;
  readonly unitAmount: number;
};

const BODY_LIMIT = 256 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TERMS_KEYS = [
  "offerPrices", "childPricing", "minimumParticipants", "minimumChargeableParticipants", "maxPartySize",
  "cancellationPolicy", "cancellationWindowMinutesBeforeStart", "cancellationRefundBasisPoints",
  "minimumAttendance", "bookingQuestions", "conditionsVersion",
] as const;

function adminJson(body: unknown, status = 200): ReturnType<typeof baseAdminJson> {
  const response = baseAdminJson(body, status);
  response.headers.set("referrer-policy", "no-referrer");
  response.headers.set("x-robots-tag", "noindex, nofollow");
  return response;
}

function isRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: RecordValue, allowed: readonly string[], required: readonly string[] = allowed): boolean {
  return Object.keys(value).every((key) => allowed.includes(key)) && required.every((key) => Object.hasOwn(value, key));
}

function validDraft(value: unknown): value is ProductDraftBody {
  return isRecord(value) && exactKeys(value, ["slug", "publicTitle", "content", "currency", "unitAmount"])
    && typeof value.slug === "string" && value.slug.length >= 1 && value.slug.length <= 160
    && typeof value.publicTitle === "string" && value.publicTitle.length >= 1 && value.publicTitle.length <= 300
    && isRecord(value.content) && value.currency === "JPY"
    && typeof value.unitAmount === "number" && Number.isSafeInteger(value.unitAmount)
    && (value.unitAmount === 0 || value.unitAmount >= 50);
}

function validSaleTermsShape(value: unknown): value is ProductSaleTermsInput {
  if (!isRecord(value) || !exactKeys(value, TERMS_KEYS, [
    "childPricing", "minimumParticipants", "maxPartySize", "cancellationPolicy", "bookingQuestions", "conditionsVersion",
  ])) return false;
  if (value.childPricing !== null && (!isRecord(value.childPricing)
    || !exactKeys(value.childPricing, ["priceYen", "minAge", "maxAge", "adultRequired"]))) return false;
  if (value.offerPrices !== undefined && value.offerPrices !== null) {
    if (!Array.isArray(value.offerPrices)) return false;
    for (const price of value.offerPrices) if (!isRecord(price) || !exactKeys(price, ["offerId", "adultPriceYen"])) return false;
  }
  if (!Array.isArray(value.bookingQuestions)) return false;
  for (const question of value.bookingQuestions) {
    if (!isRecord(question) || !exactKeys(question, ["id", "prompt", "description", "inputType", "required", "options"])
      || !Array.isArray(question.options)) return false;
    for (const option of question.options) if (!isRecord(option) || !exactKeys(option, ["id", "label"])) return false;
  }
  return value.conditionsVersion === null;
}

function encodeRevision(value: Revision): string {
  return Buffer.from(`1:${value.draft}:${value.state ?? 0}:${value.saleTerms ?? 0}`).toString("base64url");
}

function decodeRevision(value: unknown): Revision | null {
  if (typeof value !== "string" || value.length > 64 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    if (Buffer.from(decoded).toString("base64url") !== value) return null;
    const parts = decoded.split(":");
    if (parts.length !== 4 || parts[0] !== "1" || !parts.slice(1).every((part) => /^(?:0|[1-9][0-9]{0,14})$/.test(part))) return null;
    const draft = Number(parts[1]);
    const state = Number(parts[2]);
    const saleTerms = Number(parts[3]);
    if (!Number.isSafeInteger(draft) || draft < 1 || !Number.isSafeInteger(state) || !Number.isSafeInteger(saleTerms)) return null;
    return { draft, state: state === 0 ? null : state, saleTerms: saleTerms === 0 ? null : saleTerms };
  } catch { return null; }
}

function decodeBase64UrlHeader(value: string | null): string | null {
  if (value === null || value.length < 1 || value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) return null;
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch { return null; }
}

async function parseJson(request: Request): Promise<RecordValue | Response> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") return adminJson({ error: { code: "INVALID_INPUT" } }, 400);
  try {
    const value: unknown = await readBoundedJson(request, BODY_LIMIT, { fatalUtf8: true });
    return isRecord(value) ? value : adminJson({ error: { code: "INVALID_INPUT" } }, 400);
  } catch (error) {
    return adminJson({ error: { code: "INVALID_INPUT" } }, error instanceof ResponseBodyTooLarge ? 413 : 400);
  }
}

function mapStoreError(error: unknown): Response {
  if (error instanceof ExperiencePublicationBlockedError) return adminJson({ error: { code: "PUBLICATION_BLOCKED", blockers: error.blockers } }, 422);
  if (error instanceof DomainValidationError) return adminJson({ error: { code: "INVALID_INPUT" } }, 400);
  if (error instanceof StoreAccessDeniedError) return adminJson({ error: { code: "FORBIDDEN" } }, 403);
  if (error instanceof StoreNotFoundError) return adminJson({ error: { code: "NOT_FOUND" } }, 404);
  if (error instanceof StoreConflictError) return adminJson({ error: { code: "VERSION_CONFLICT" } }, 409);
  if (error instanceof StoreValidationError) return adminJson({ error: { code: "INVALID_INPUT" } }, 422);
  return adminJson({ error: { code: "UNAVAILABLE" } }, 503);
}

async function authorize(request: Request, mutation = false): Promise<
  { readonly ok: true; readonly actor: PublicationAdminDraftActor }
  | { readonly ok: false; readonly response: Response }
> {
  if (!isAdminHttp() || !config.experienceHostPublicationApiEnabled) return { ok: false, response: adminJson({ error: { code: "NOT_FOUND" } }, 404) };
  const load = await loadAdminHttpSession();
  if (load.status === "ok") {
    if (mutation && !adminMutationAllowed(request)) return { ok: false, response: adminJson({ error: { code: "FORBIDDEN" } }, 403) };
    return { ok: true, actor: { nihoUserId: load.verified.actor.id } };
  }
  if (load.status === "error") return { ok: false, response: adminJson({ error: { code: "UNAVAILABLE" } }, 503) };
  const response = adminJson({ error: { code: load.status === "refresh" ? "SESSION_REFRESH_REQUIRED" : "SESSION_ENDED" } }, 401);
  if (load.status === "rejected") clearAdminHttpSessionCookie(response);
  return { ok: false, response };
}

async function productDto(actor: PublicationAdminDraftActor, providerId: string, productId: string) {
  const repository = experiencePublicationRepository();
  if (!repository) throw new Error("store unavailable");
  const [product, terms, media, offers, publication] = await Promise.all([
    repository.getAdminDraftProduct(actor, providerId, productId),
    repository.getAdminDraftSaleTerms(actor, providerId, productId),
    repository.listAdminDraftMedia(actor, providerId, productId),
    repository.listAdminDraftSaleOffers(actor, providerId, productId),
    repository.getAdminDraftPublicationStatus(actor, providerId, productId, config.experiencePublicationConsentVersion),
  ]);
  if (product.version !== publication.draftVersion
    || terms.draftVersion !== publication.draftVersion
    || (terms.saleTerms?.version ?? null) !== publication.saleTermsVersion) {
    throw new StoreConflictError("Product changed while preparing the Admin publication workspace.");
  }
  return {
    id: product.id,
    version: encodeRevision({ draft: publication.draftVersion, state: publication.stateVersion, saleTerms: publication.saleTermsVersion }),
    status: "DRAFT" as const,
    publicationNeedsUpdate: false,
    publicationBlockers: publication.blockers,
    adminEnglishReview: publication.englishReview,
    draft: { slug: product.slug, publicTitle: product.publicTitle, content: product.content, currency: product.currency, unitAmount: product.unitAmount },
    sellerDisplayName: product.sellerDisplayName,
    saleTerms: terms.saleTerms,
    offers,
    media: media.map((asset) => ({ ...asset, previewUrl: `/admin/api/product-workspaces/${encodeURIComponent(providerId)}/products/${encodeURIComponent(productId)}/media/${encodeURIComponent(asset.id)}` })),
  };
}

export async function adminDraftSellerCollection(request: Request): Promise<Response> {
  const auth = await authorize(request, request.method !== "GET");
  if (!auth.ok) return auth.response;
  if (request.method !== "GET" || new URL(request.url).search) return adminJson({ error: { code: "NOT_FOUND" } }, 404);
  const repository = experiencePublicationRepository();
  if (!repository) return adminJson({ error: { code: "UNAVAILABLE" } }, 503);
  try { return adminJson({ sellers: await repository.listAdminDraftSellers(auth.actor) }); }
  catch (error) { return mapStoreError(error); }
}

export async function adminDraftProductCollection(request: Request, context: ProviderContext): Promise<Response> {
  const auth = await authorize(request, request.method !== "GET");
  if (!auth.ok) return auth.response;
  const { providerId } = await context.params;
  if (!ID.test(providerId) || new URL(request.url).search || (request.method !== "GET" && request.method !== "POST")) return adminJson({ error: { code: "NOT_FOUND" } }, 404);
  const repository = experiencePublicationRepository();
  if (!repository) return adminJson({ error: { code: "UNAVAILABLE" } }, 503);
  try {
    if (request.method === "GET") {
      const products = await repository.listAdminDraftProducts(auth.actor, providerId);
      return adminJson({
        products: await Promise.all(products.map((product) => productDto(auth.actor, providerId, product.id))),
        publicationConsentVersion: config.experiencePublicationConsentVersion,
      });
    }
    const body = await parseJson(request);
    if (body instanceof Response || !validDraft(body)) return body instanceof Response ? body : adminJson({ error: { code: "INVALID_INPUT" } }, 400);
    const created = await repository.createDraftAsAdmin(auth.actor, providerId, body as ExperiencePublicationDraftCreateInput);
    return adminJson({ product: await productDto(auth.actor, providerId, created.id), publicationConsentVersion: config.experiencePublicationConsentVersion }, 201);
  } catch (error) { return mapStoreError(error); }
}

export async function adminDraftProductRequest(request: Request, context: ProductContext): Promise<Response> {
  const auth = await authorize(request, request.method !== "GET");
  if (!auth.ok) return auth.response;
  const { providerId, productId } = await context.params;
  if (!ID.test(providerId) || !ID.test(productId) || new URL(request.url).search || (request.method !== "GET" && request.method !== "PATCH")) return adminJson({ error: { code: "NOT_FOUND" } }, 404);
  const repository = experiencePublicationRepository();
  if (!repository) return adminJson({ error: { code: "UNAVAILABLE" } }, 503);
  try {
    if (request.method === "GET") return adminJson({ product: await productDto(auth.actor, providerId, productId), publicationConsentVersion: config.experiencePublicationConsentVersion });
    const body = await parseJson(request);
    if (body instanceof Response || !exactKeys(body, ["version", "draft"]) || !validDraft(body.draft)) return body instanceof Response ? body : adminJson({ error: { code: "INVALID_INPUT" } }, 400);
    const revision = decodeRevision(body.version);
    if (!revision) return adminJson({ error: { code: "INVALID_INPUT" } }, 400);
    const current = await repository.getAdminDraftProduct(auth.actor, providerId, productId);
    const draft = body.draft as ProductDraftBody;
    await repository.saveDraftAsAdmin(auth.actor, providerId, {
      id: productId, ...draft, content: draft.content, cancellationTermsRef: current.cancellationTermsRef,
    } as ExperiencePublicationDraftInput, revision.draft);
    return adminJson({ product: await productDto(auth.actor, providerId, productId), publicationUpdated: false, publicationConsentVersion: config.experiencePublicationConsentVersion });
  } catch (error) { return mapStoreError(error); }
}

export async function adminDraftEnglishReviewRequest(request: Request, context: ProductContext): Promise<Response> {
  const auth = await authorize(request, true);
  if (!auth.ok) return auth.response;
  const { providerId, productId } = await context.params;
  if (!ID.test(providerId) || !ID.test(productId) || new URL(request.url).search || request.method !== "POST") return adminJson({ error: { code: "NOT_FOUND" } }, 404);
  const body = await parseJson(request);
  if (body instanceof Response || !exactKeys(body, ["version", "reviewed"]) || body.reviewed !== true) {
    return body instanceof Response ? body : adminJson({ error: { code: "INVALID_INPUT" } }, 400);
  }
  const revision = decodeRevision(body.version);
  if (!revision) return adminJson({ error: { code: "INVALID_INPUT" } }, 400);
  const repository = experiencePublicationRepository();
  if (!repository) return adminJson({ error: { code: "UNAVAILABLE" } }, 503);
  try {
    await repository.reviewAdminDraftEnglish(auth.actor, providerId, productId, revision.draft);
    return adminJson({
      product: await productDto(auth.actor, providerId, productId),
      publicationConsentVersion: config.experiencePublicationConsentVersion,
    });
  } catch (error) { return mapStoreError(error); }
}

export async function adminDraftPublishRequest(request: Request, context: ProductContext): Promise<Response> {
  const auth = await authorize(request, true);
  if (!auth.ok) return auth.response;
  const { providerId, productId } = await context.params;
  if (!ID.test(providerId) || !ID.test(productId) || new URL(request.url).search || request.method !== "POST") return adminJson({ error: { code: "NOT_FOUND" } }, 404);
  const body = await parseJson(request);
  if (body instanceof Response || !exactKeys(body, ["version", "accepted", "sellerConfirmationMethod", "photoRightsConfirmed", "consentVersion"])
    || body.accepted !== true || body.photoRightsConfirmed !== true
    || (body.sellerConfirmationMethod !== "VERBAL" && body.sellerConfirmationMethod !== "WRITTEN")
    || typeof body.consentVersion !== "string" || body.consentVersion.length < 1 || body.consentVersion.length > 160) {
    return body instanceof Response ? body : adminJson({ error: { code: "INVALID_INPUT" } }, 400);
  }
  if (body.consentVersion !== config.experiencePublicationConsentVersion) {
    return adminJson({ error: { code: "PUBLICATION_BLOCKED", blockers: ["CONSENT_OUTDATED"] } }, 422);
  }
  const revision = decodeRevision(body.version);
  if (!revision) return adminJson({ error: { code: "INVALID_INPUT" } }, 400);
  const repository = experiencePublicationRepository();
  if (!repository) return adminJson({ error: { code: "UNAVAILABLE" } }, 503);
  try {
    const state = await repository.publishAdminDraft(auth.actor, providerId, productId, {
      expectedDraftVersion: revision.draft,
      expectedStateVersion: revision.state,
      expectedSaleTermsVersion: revision.saleTerms,
      consentVersion: body.consentVersion,
      accepted: true,
      sellerConfirmationMethod: body.sellerConfirmationMethod,
      photoRightsConfirmed: true,
    });
    return adminJson({ publication: { status: "PUBLISHED", version: state.version } });
  } catch (error) { return mapStoreError(error); }
}

export async function adminDraftSaleTermsRequest(request: Request, context: ProductContext): Promise<Response> {
  const auth = await authorize(request, true);
  if (!auth.ok) return auth.response;
  const { providerId, productId } = await context.params;
  if (!ID.test(providerId) || !ID.test(productId) || new URL(request.url).search || request.method !== "PUT") return adminJson({ error: { code: "NOT_FOUND" } }, 404);
  const body = await parseJson(request);
  if (body instanceof Response || !exactKeys(body, ["version", "saleTerms"]) || !validSaleTermsShape(body.saleTerms)) return body instanceof Response ? body : adminJson({ error: { code: "INVALID_INPUT" } }, 400);
  const revision = decodeRevision(body.version);
  if (!revision) return adminJson({ error: { code: "INVALID_INPUT" } }, 400);
  try { validSaleTerms(body.saleTerms); } catch { return adminJson({ error: { code: "INVALID_INPUT" } }, 400); }
  const repository = experiencePublicationRepository();
  if (!repository) return adminJson({ error: { code: "UNAVAILABLE" } }, 503);
  try {
    await repository.saveSaleTermsAsAdmin(auth.actor, providerId, productId, {
      expectedDraftVersion: revision.draft, expectedSaleTermsVersion: revision.saleTerms,
      saleTerms: body.saleTerms as ProductSaleTermsInput,
    });
    return adminJson({ product: await productDto(auth.actor, providerId, productId), publicationUpdated: false, publicationConsentVersion: config.experiencePublicationConsentVersion });
  } catch (error) { return mapStoreError(error); }
}

export async function adminDraftMediaRequest(request: Request, context: ProductContext): Promise<Response> {
  const auth = await authorize(request, true);
  if (!auth.ok) return auth.response;
  const { providerId, productId } = await context.params;
  if (!ID.test(providerId) || !ID.test(productId) || new URL(request.url).search || (request.method !== "POST" && request.method !== "PUT")) return adminJson({ error: { code: "NOT_FOUND" } }, 404);
  const repository = experiencePublicationRepository();
  if (!repository) return adminJson({ error: { code: "UNAVAILABLE" } }, 503);
  if (request.method === "PUT") {
    const body = await parseJson(request);
    if (body instanceof Response || !exactKeys(body, ["version", "media"]) || !Array.isArray(body.media) || body.media.length > 20) return body instanceof Response ? body : adminJson({ error: { code: "INVALID_INPUT" } }, 400);
    const revision = decodeRevision(body.version);
    if (!revision) return adminJson({ error: { code: "INVALID_INPUT" } }, 400);
    const media: ExperienceHostMediaSelectionInput[] = [];
    for (const item of body.media) {
      if (!isRecord(item) || !exactKeys(item, ["id", "altText", "altTextJa", "publicCredit"])
        || typeof item.id !== "string" || typeof item.altText !== "string" || typeof item.altTextJa !== "string"
        || (item.publicCredit !== null && typeof item.publicCredit !== "string")) return adminJson({ error: { code: "INVALID_INPUT" } }, 400);
      media.push({ id: item.id, altText: item.altText, altTextJa: item.altTextJa, publicCredit: item.publicCredit as string | null });
    }
    try {
      await repository.saveMediaSelectionAsAdmin(auth.actor, providerId, productId, revision.draft, media);
      return adminJson({ product: await productDto(auth.actor, providerId, productId), publicationConsentVersion: config.experiencePublicationConsentVersion });
    } catch (error) { return mapStoreError(error); }
  }
  if (request.headers.get("x-experience-photo-rights-confirmed") !== "true") return adminJson({ error: { code: "PHOTO_RIGHTS_CONFIRMATION_REQUIRED" } }, 422);
  const altText = decodeBase64UrlHeader(request.headers.get("x-experience-photo-alt-text-utf8-base64url")) ?? "";
  const altTextJa = decodeBase64UrlHeader(request.headers.get("x-experience-photo-alt-text-ja-utf8-base64url")) ?? "";
  const creditHeader = request.headers.get("x-experience-photo-credit-utf8-base64url");
  const publicCredit = creditHeader === null ? null : decodeBase64UrlHeader(creditHeader);
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (altText.trim() === "" || altText.length > 500 || altTextJa.trim() === "" || altTextJa.length > 500
    || request.headers.get("x-experience-media-placement") !== "GALLERY"
    || (creditHeader !== null && publicCredit === null) || (publicCredit !== null && (publicCredit.trim() === "" || publicCredit.length > 300))) return adminJson({ error: { code: "INVALID_INPUT" } }, 400);
  if (mediaType !== "image/jpeg" && mediaType !== "image/png") return adminJson({ error: { code: "UNSUPPORTED_FORMAT" } }, 415);
  const storage = experiencePublicMediaStorage();
  if (!storage) return adminJson({ error: { code: "UNAVAILABLE" } }, 503);
  let original: Buffer;
  let processed: Awaited<ReturnType<typeof processGuideCoverImage>>;
  try { original = await readGuideCoverInput(request); processed = await processGuideCoverImage(original); }
  catch (error) {
    if (error instanceof GuideCoverImageError) return adminJson({ error: { code: error.code.toUpperCase() } }, error.code === "payload_too_large" ? 413 : error.code === "unsupported_format" ? 415 : 400);
    return adminJson({ error: { code: "INVALID_INPUT" } }, 400);
  }
  const id = randomUUID();
  const objectKey = `experience-products/${id}.jpg`;
  let stored = false;
  let registered = false;
  try {
    await storage.write(objectKey, processed.bytes); stored = true;
    const asset: ExperienceHostMediaAssetInput = {
      id, objectKey, sourceRefHash: createHash("sha256").update(original).digest("hex"),
      width: processed.width, height: processed.height, byteSize: processed.bytes.byteLength,
      altText, altTextJa, publicCredit,
    };
    await repository.addMediaAsAdmin(auth.actor, providerId, productId, asset); registered = true;
    return adminJson({ product: await productDto(auth.actor, providerId, productId), publicationConsentVersion: config.experiencePublicationConsentVersion }, 201);
  } catch (error) {
    if (stored && !registered) await storage.remove(objectKey).catch(() => undefined);
    return mapStoreError(error);
  }
}

export async function adminDraftMediaAssetRequest(request: Request, context: AssetContext): Promise<Response> {
  const auth = await authorize(request, request.method !== "GET");
  if (!auth.ok) return auth.response;
  const { providerId, productId, assetId } = await context.params;
  if (request.method !== "GET" || !ID.test(providerId) || !ID.test(productId) || !UUID_V4.test(assetId) || new URL(request.url).search) return adminJson({ error: { code: "NOT_FOUND" } }, 404);
  const repository = experiencePublicationRepository();
  const storage = experiencePublicMediaStorage();
  if (!repository || !storage) return adminJson({ error: { code: "UNAVAILABLE" } }, 503);
  try {
    const asset = (await repository.listAdminDraftMedia(auth.actor, providerId, productId)).find((item) => item.id === assetId);
    if (!asset) return adminJson({ error: { code: "NOT_FOUND" } }, 404);
    const bytes = await storage.read(`experience-products/${asset.id}.jpg`);
    if (bytes.byteLength !== asset.byteSize) return adminJson({ error: { code: "UNAVAILABLE" } }, 503);
    return new Response(Uint8Array.from(bytes).buffer, { headers: {
      "cache-control": "private, no-store", "content-type": "image/jpeg", "content-length": String(bytes.byteLength),
      "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", "x-robots-tag": "noindex, nofollow",
    } });
  } catch (error) { return mapStoreError(error); }
}

export async function adminDraftCalendarRequest(request: Request, context: ProductContext): Promise<Response> {
  const auth = await authorize(request, request.method !== "GET");
  if (!auth.ok) return auth.response;
  const { providerId, productId } = await context.params;
  const url = new URL(request.url);
  if (!ID.test(providerId) || !ID.test(productId) || (request.method !== "GET" && request.method !== "POST")
    || (request.method === "POST" && url.search)) return adminJson({ error: "not_found" }, 404);
  const store = experienceStore();
  const repository = experiencePublicationRepository();
  if (!store || !repository) return adminJson({ error: "calendar_not_configured" }, 503);
  try {
    const product = await repository.getAdminDraftProduct(auth.actor, providerId, productId);
    if (request.method === "GET") {
      const fromDate = url.searchParams.get("fromDate");
      const toDate = url.searchParams.get("toDate");
      const queryKeys = [...url.searchParams.keys()].sort();
      if (queryKeys.length !== 3 || queryKeys.join(",") !== "fromDate,providerId,toDate"
        || url.searchParams.get("providerId") !== providerId || !fromDate || !toDate) {
        return adminJson({ error: "invalid_range" }, 400);
      }
      try {
        assertLocalDate(fromDate, "fromDate");
        assertLocalDate(toDate, "toDate");
        const distance = localDateDistance(fromDate, toDate);
        if (distance < 0 || distance > 89) return adminJson({ error: "invalid_range" }, 400);
      } catch {
        return adminJson({ error: "invalid_range" }, 400);
      }
      const views = await store.listDraftScheduleAsAdmin(auth.actor, providerId, productId);
      const rules = views.map((view) => ({ ...view.rule.rule, experienceId: productId }));
      const occurrences = views.flatMap((view) => expandOccurrences({
        rule: view.rule.rule, overrides: view.overrides.map((item) => item.override),
        salesStates: view.salesStates.map((item) => item.state), fromDate, toDate,
      }).map((item) => ({ ...item, experienceId: productId, experienceTitle: product.publicTitle,
        availableSeats: item.capacity, confirmedSeats: 0, heldSeats: 0, availabilityReason: "AVAILABLE" as const, canReschedule: false })));
      return adminJson({ scope: "MEMBER", preview: false, canEdit: true, experiences: [{ id: productId, title: product.publicTitle }],
        rules, occurrences, busyIntervals: [], google: { connected: false, canManage: false, blockingEnabled: false, syncStatus: "STALE" } });
    }
    const body = await parseJson(request);
    if (body instanceof Response || !exactKeys(body, ["providerId", "action", "experienceId", "rule", "commandId"])
      || body.providerId !== providerId || body.experienceId !== productId || body.action !== "createRule"
      || typeof body.commandId !== "string" || !UUID_V4.test(body.commandId) || !isRecord(body.rule)) return body instanceof Response ? body : adminJson({ error: "invalid_body" }, 400);
    const rule: ScheduleRule = parseScheduleRule({ ...body.rule, id: body.commandId });
    const saved = await store.saveDraftScheduleRuleAsAdmin(auth.actor, providerId, productId, rule, null, body.commandId);
    return adminJson({ id: saved.aggregateId, version: saved.version }, saved.repeated ? 200 : 201);
  } catch (error) { return mapStoreError(error); }
}
