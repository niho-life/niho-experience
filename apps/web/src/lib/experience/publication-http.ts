import "server-only";
import {
  ExperiencePublicationBlockedError,
  StoreAccessDeniedError,
  StoreConflictError,
  StoreNotFoundError,
  StoreValidationError,
  validSaleTerms,
  projectPublicExperiencePublicationManuscript,
  type ExperienceHostMediaAssetInput,
  type ExperienceHostMediaSelectionInput,
  type ExperienceHostProviderMediaAssetInput,
  type ExperienceHostProviderMediaSelectionInput,
  type ExperiencePublicationDraftCreateInput,
  type ExperiencePublicationDraftInput,
  type ExperiencePublicationState,
  type JsonValue,
  type ProductSaleTermsInput,
  validateGuestMeetingGuide,
} from "@niho-experience/experience-store";
import { createHash, randomUUID } from "node:crypto";
import { config } from "@/lib/config";
import { noStoreJson } from "@/lib/host/server";
import { ResponseBodyTooLarge, readBoundedJson } from "@/lib/read-bounded-json";
import { experiencePublicationRepository, guestMeetingGuideRepository } from "./store-server";
import {
  publicationHostBoundary,
  publicationHostMutationAllowed,
  type PublicationHostContext,
} from "./publication-host-boundary";
import { experiencePublicMediaStorage } from "./public-media-storage";
import { GuideCoverImageError, processGuideCoverImage, readGuideCoverInput } from "@/lib/editor/guide-cover-image";
import { anthropicTranslator } from "@/lib/translation/anthropic";
import { experienceManuscriptToEnglish } from "@/lib/translation/prompts";

export type PublicationProductContext = { params: Promise<{ productId: string }> };
type RecordValue = Record<string, unknown>;
type ProductRevision = { readonly draft: number; readonly state: number | null; readonly saleTerms: number | null };
type ProductStatus = "DRAFT" | "PUBLISHED" | "STOPPED" | "RESTART_REQUIRED" | "SUSPENDED";
type ProductDraftBody = {
  readonly slug: string;
  readonly publicTitle: string;
  readonly content: Readonly<Record<string, JsonValue>>;
  readonly currency: string;
  readonly unitAmount: number;
};
type Action = "read" | "save" | "publish" | "stop" | "readSaleTerms" | "saveSaleTerms" | "readBookingGuide" | "saveBookingGuide";
const BODY_LIMIT = 256 * 1024;
const PRODUCT_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TERMS_KEYS = [
  "offerPrices", "childPricing", "minimumParticipants", "minimumChargeableParticipants", "maxPartySize",
  "cancellationPolicy", "cancellationWindowMinutesBeforeStart", "cancellationRefundBasisPoints",
  "minimumAttendance", "bookingQuestions", "conditionsVersion",
] as const;

function isRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function exactKeys(value: RecordValue, allowed: readonly string[], required: readonly string[] = allowed): boolean {
  return Object.keys(value).every((key) => allowed.includes(key)) && required.every((key) => Object.hasOwn(value, key));
}

function versionPart(value: number | null): string { return value === null ? "0" : String(value); }

function decodeBase64UrlHeader(value: string | null): string | null {
  if (value === null || value.length < 1 || value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) return null;
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch { return null; }
}

/** The browser carries one opaque product revision; the server expands it into the Store's CAS values. */
function encodeRevision(value: ProductRevision): string {
  return Buffer.from(`1:${value.draft}:${versionPart(value.state)}:${versionPart(value.saleTerms)}`).toString("base64url");
}

function decodeRevision(value: unknown): ProductRevision | null {
  if (typeof value !== "string" || value.length > 64 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    if (Buffer.from(decoded).toString("base64url") !== value) return null;
    const parts = decoded.split(":");
    if (parts.length !== 4 || parts[0] !== "1" || !parts.slice(1).every((part) => /^(?:0|[1-9][0-9]{0,14})$/.test(part))) return null;
    const [draft, state, saleTerms] = parts.slice(1).map(Number);
    if (!Number.isSafeInteger(draft) || draft! < 1 || !Number.isSafeInteger(state) || !Number.isSafeInteger(saleTerms)) return null;
    return { draft: draft!, state: state === 0 ? null : state!, saleTerms: saleTerms === 0 ? null : saleTerms! };
  } catch { return null; }
}

function validDraft(value: unknown): value is ProductDraftBody {
  return isRecord(value)
    && exactKeys(value, ["slug", "publicTitle", "content", "currency", "unitAmount"])
    && typeof value.slug === "string" && value.slug.length >= 1 && value.slug.length <= 160
    && typeof value.publicTitle === "string" && value.publicTitle.length >= 1 && value.publicTitle.length <= 300
    && isRecord(value.content)
    && value.currency === "JPY"
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
    for (const price of value.offerPrices) {
      if (!isRecord(price) || !exactKeys(price, ["offerId", "adultPriceYen"])) return false;
    }
  }
  if (!Array.isArray(value.bookingQuestions)) return false;
  for (const question of value.bookingQuestions) {
    if (!isRecord(question) || !exactKeys(question, ["id", "prompt", "description", "inputType", "required", "options"])
      || !Array.isArray(question.options)) return false;
    for (const option of question.options) if (!isRecord(option) || !exactKeys(option, ["id", "label"])) return false;
  }
  return value.conditionsVersion === null;
}

async function parseJson(request: Request): Promise<RecordValue | Response> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    return noStoreJson({ error: { code: "INVALID_INPUT" } }, 400);
  }
  try {
    const value: unknown = await readBoundedJson(request, BODY_LIMIT, { fatalUtf8: true });
    return isRecord(value) ? value : noStoreJson({ error: { code: "INVALID_INPUT" } }, 400);
  } catch (error) {
    return noStoreJson({ error: { code: "INVALID_INPUT" } }, error instanceof ResponseBodyTooLarge ? 413 : 400);
  }
}

function responseError(code: string, status: number, extra: RecordValue = {}): Response {
  return noStoreJson({ error: { code, ...extra } }, status);
}

function mapStoreError(error: unknown): Response {
  if (error instanceof ExperiencePublicationBlockedError) return responseError("PUBLICATION_BLOCKED", 422, { blockers: error.blockers });
  if (error instanceof StoreAccessDeniedError) return responseError("FORBIDDEN", 403);
  if (error instanceof StoreNotFoundError) return responseError("NOT_FOUND", 404);
  if (error instanceof StoreConflictError) return responseError("VERSION_CONFLICT", 409);
  if (error instanceof StoreValidationError) return responseError("INVALID_INPUT", 422);
  return responseError("UNAVAILABLE", 503);
}

async function prepareHost(operation: "READ" | "EDIT" | "OWNER"): Promise<
  { readonly ok: true; readonly context: PublicationHostContext; readonly repository: NonNullable<ReturnType<typeof experiencePublicationRepository>> }
  | { readonly ok: false; readonly response: Response }
> {
  const boundary = await publicationHostBoundary(operation);
  if (!boundary.ok) return boundary;
  const repository = experiencePublicationRepository();
  if (!repository) return { ok: false, response: responseError("UNAVAILABLE", 503) };
  try {
    await repository.ensureOwnerWorkspace(boundary.value.actor);
    if (boundary.value.readiness) await repository.refreshReadiness(boundary.value.actor, boundary.value.readiness);
    return { ok: true, context: boundary.value, repository };
  } catch (error) {
    return { ok: false, response: mapStoreError(error) };
  }
}

function publicationStatus(state: ExperiencePublicationState | null): ProductStatus {
  if (!state || state.currentPublicationId === null) return "DRAFT";
  if (state.operationsSuspendedAtUtc !== null) return "SUSPENDED";
  if (state.ownerResumeRequired) return "RESTART_REQUIRED";
  if (state.selfStoppedAtUtc !== null) return "STOPPED";
  return "PUBLISHED";
}

async function productDto(repository: NonNullable<ReturnType<typeof experiencePublicationRepository>>, actor: PublicationHostContext["actor"], productId: string) {
  const [product, state, termsState, media, publicationNeedsUpdate] = await Promise.all([
    repository.getProduct(actor, productId),
    repository.getState(actor, productId),
    repository.getSaleTerms(actor, productId),
    repository.listMedia(actor, productId),
    repository.hasPendingPublicationChanges(actor, productId),
  ]);
  const revision: ProductRevision = {
    draft: product.version,
    state: state?.version ?? null,
    saleTerms: termsState.saleTerms?.version ?? null,
  };
  return {
    id: product.id,
    version: encodeRevision(revision),
    status: publicationStatus(state),
    publicationNeedsUpdate,
    draft: {
      slug: product.slug,
      publicTitle: product.publicTitle,
      content: product.content,
      currency: product.currency,
      unitAmount: product.unitAmount,
    },
    sellerDisplayName: product.sellerDisplayName,
    saleTerms: termsState.saleTerms,
    media: media.map((asset) => ({
      ...asset,
      previewUrl: `/host/api/products/${encodeURIComponent(product.id)}/media/${encodeURIComponent(asset.id)}`,
    })),
  };
}

async function providerMediaDto(repository: NonNullable<ReturnType<typeof experiencePublicationRepository>>, actor: PublicationHostContext["actor"]) {
  const profile = await repository.getProviderMedia(actor);
  return {
    ...profile,
    assets: profile.assets.map((asset) => ({
      ...asset,
      previewUrl: `/host/api/provider-media/${encodeURIComponent(asset.id)}`,
    })),
  };
}

function checksFor(content: Readonly<Record<string, unknown>>, photosReady: boolean, publicTitle: string) {
  const japanese = content.ja;
  const translation = content.translation;
  const english = {
    title: publicTitle,
    lead: content.lead,
    description: content.description,
    language: isRecord(content.facts) ? content.facts.language : null,
    highlights: content.highlights,
    included: content.included,
    notIncluded: content.notIncluded,
    knowBeforeYouGo: content.knowBeforeYouGo,
    notSuitableFor: content.notSuitableFor,
    timeline: content.timeline,
  };
  const localeReady = validLocaleManuscript(japanese)
    && isRecord(translation)
    && typeof translation.sourceFingerprint === "string"
    && typeof translation.confirmedSourceFingerprint === "string"
    && typeof translation.confirmedEnglishFingerprint === "string"
    && translation.sourceFingerprint === createHash("sha256").update(canonicalJson(japanese), "utf8").digest("hex")
    && translation.confirmedSourceFingerprint === translation.sourceFingerprint
    && translation.confirmedEnglishFingerprint === createHash("sha256").update(canonicalJson(english), "utf8").digest("hex");
  return { manuscriptReady: projectPublicExperiencePublicationManuscript(content as never) !== null && localeReady, photosReady };
}

function actionOperation(action: Action): "READ" | "EDIT" | "OWNER" {
  if (action === "publish" || action === "stop" || action === "readBookingGuide" || action === "saveBookingGuide") return "OWNER";
  if (action === "save" || action === "saveSaleTerms") return "EDIT";
  return "READ";
}

function validActionBody(action: Action, body: RecordValue): ProductRevision | null {
  if (action === "save") {
    if (!exactKeys(body, ["version", "draft"]) || !validDraft(body.draft)) return null;
    return decodeRevision(body.version);
  }
  if (action === "saveSaleTerms") {
    if (!exactKeys(body, ["version", "saleTerms"]) || !validSaleTermsShape(body.saleTerms)) return null;
    try { validSaleTerms(body.saleTerms); return decodeRevision(body.version); }
    catch { return null; }
  }
  if (action === "stop") return exactKeys(body, ["version"]) ? decodeRevision(body.version) : null;
  if (action === "publish") {
    return exactKeys(body, ["version", "consentVersion", "accepted"])
      && typeof body.consentVersion === "string" && body.consentVersion.length >= 1 && body.consentVersion.length <= 160
      && typeof body.accepted === "boolean"
      ? decodeRevision(body.version) : null;
  }
  return null;
}

/** `GET/POST /host/api/products`: the seller comes from the NIHO session, never from browser input. */
export async function publicationCollectionRequest(request: Request, action: "list" | "create"): Promise<Response> {
  if (!config.experienceHostPublicationApiEnabled) return responseError("NOT_FOUND", 404);
  if (!publicationHostMutationAllowed(request)) return responseError("FORBIDDEN", 403);
  if (new URL(request.url).search) return responseError("NOT_FOUND", 404);
  let body: RecordValue | null = null;
  if (action === "create") {
    const parsed = await parseJson(request);
    if (parsed instanceof Response) return parsed;
    body = parsed;
    if (!validDraft(body)) return responseError("INVALID_INPUT", 400);
  }
  const prepared = await prepareHost(action === "create" ? "OWNER" : "READ");
  if (!prepared.ok) return prepared.response;
  try {
    if (action === "list") {
      const products = await prepared.repository.listProducts(prepared.context.actor);
      const items = await Promise.all(products.map((product) => productDto(prepared.repository, prepared.context.actor, product.id)));
      return noStoreJson({ products: items, publicationConsentVersion: config.experiencePublicationConsentVersion });
    }
    if (!prepared.context.readiness || !prepared.context.readiness.accountUsable || !prepared.context.readiness.sellerDisplayReady) {
      return responseError("SELLER_SETUP_REQUIRED", 409);
    }
    const product = await prepared.repository.createDraft(prepared.context.actor, body as ExperiencePublicationDraftCreateInput);
    return noStoreJson({ product: await productDto(prepared.repository, prepared.context.actor, product.id) }, 201);
  } catch (error) { return mapStoreError(error); }
}

/** Host product operations. One opaque version covers draft, sale terms and publication state. */
export async function publicationRequest(request: Request, context: PublicationProductContext, action: Action): Promise<Response> {
  if (!config.experienceHostPublicationApiEnabled) return responseError("NOT_FOUND", 404);
  const productId = (await context.params).productId;
  if (!PRODUCT_ID.test(productId) || new URL(request.url).search) return responseError("NOT_FOUND", 404);
  if (!publicationHostMutationAllowed(request)) return responseError("FORBIDDEN", 403);

  let body: RecordValue | null = null;
  let revision: ProductRevision | null = null;
  if (action !== "read" && action !== "readSaleTerms" && action !== "readBookingGuide") {
    const parsed = await parseJson(request);
    if (parsed instanceof Response) return parsed;
    body = parsed;
    if (action === "saveBookingGuide") {
      if (!exactKeys(body, ["expectedVersion", "guide"])
        || (body.expectedVersion !== null && (!Number.isSafeInteger(body.expectedVersion) || Number(body.expectedVersion) < 1))) {
        return responseError("INVALID_INPUT", 400);
      }
      try { validateGuestMeetingGuide(body.guide); } catch { return responseError("INVALID_INPUT", 400); }
    } else {
      revision = validActionBody(action, body);
      if (!revision) return responseError("INVALID_INPUT", 400);
    }
    if (action === "publish") {
      if (body.accepted !== true) return responseError("PUBLICATION_BLOCKED", 422, { blockers: ["CONSENT_REQUIRED"] });
      if (body.consentVersion !== config.experiencePublicationConsentVersion) {
        return responseError("PUBLICATION_BLOCKED", 422, { blockers: ["CONSENT_OUTDATED"] });
      }
    }
  }

  const prepared = await prepareHost(actionOperation(action));
  if (!prepared.ok) return prepared.response;
  const { repository } = prepared;
  const actor = prepared.context.actor;
  try {
    if (action === "readBookingGuide" || action === "saveBookingGuide") {
      const guides = guestMeetingGuideRepository();
      if (!guides) return responseError("UNAVAILABLE", 503);
      if (action === "readBookingGuide") return noStoreJson({ bookingGuide: await guides.readForProduct(actor, productId) });
      return noStoreJson({ bookingGuide: await guides.saveForProduct(actor, productId, body!.expectedVersion as number | null, body!.guide) });
    }
    if (action === "read") return noStoreJson({ product: await productDto(repository, actor, productId), publicationConsentVersion: config.experiencePublicationConsentVersion });
    if (action === "readSaleTerms") return noStoreJson({ product: await productDto(repository, actor, productId) });
    const product = await repository.getProduct(actor, productId);
    const state = await repository.getState(actor, productId);
    const terms = await repository.getSaleTerms(actor, productId);
    const selectedMedia = await repository.listMedia(actor, productId);
    const gallery = selectedMedia.filter((media) => media.placement === "GALLERY");
    const photosReady = gallery.length > 0 && gallery.every((media) => media.altText.trim() !== "" && media.altTextJa.trim() !== "");

    if (action === "save") {
      const input = body!.draft as ProductDraftBody;
      const checks = checksFor(input.content, photosReady, input.publicTitle);
      const result = await repository.saveDraft(actor, {
        id: productId,
        ...input,
        content: input.content,
        cancellationTermsRef: product.cancellationTermsRef,
      } as ExperiencePublicationDraftInput, revision!.draft, revision!.state, checks);
      return noStoreJson({
        product: await productDto(repository, actor, productId),
        publicationUpdated: result.publicationUpdated,
        blockers: result.blockers,
      });
    }
    const checks = checksFor(product.content, photosReady, product.publicTitle);
    if (action === "saveSaleTerms") {
      const result = await repository.saveSaleTerms(actor, productId, {
        expectedDraftVersion: revision!.draft,
        expectedStateVersion: revision!.state,
        expectedSaleTermsVersion: revision!.saleTerms,
        saleTerms: body!.saleTerms as ProductSaleTermsInput,
        checks,
      });
      return noStoreJson({
        product: await productDto(repository, actor, productId),
        publicationUpdated: result.publicationUpdated,
        blockers: result.blockers,
      });
    }
    if (action === "publish") {
      if (!prepared.context.readiness?.connectReady) return responseError("PUBLICATION_BLOCKED", 422, { blockers: ["CONNECT_NOT_READY"] });
      const currentTermsVersion = terms.saleTerms?.version ?? null;
      if (currentTermsVersion !== revision!.saleTerms) return responseError("VERSION_CONFLICT", 409);
      await repository.publish(actor, productId, {
        expectedDraftVersion: revision!.draft,
        expectedStateVersion: revision!.state,
        expectedSaleTermsVersion: revision!.saleTerms,
        consentVersion: config.experiencePublicationConsentVersion,
        checks,
      });
      return noStoreJson({ product: await productDto(repository, actor, productId) });
    }
    if (action === "stop") {
      if (state?.version !== revision!.state) return responseError("VERSION_CONFLICT", 409);
      await repository.stop(actor, productId, state.version);
      return noStoreJson({ product: await productDto(repository, actor, productId) });
    }
    return responseError("NOT_FOUND", 404);
  } catch (error) { return mapStoreError(error); }
}

/** Add a rights-confirmed photo to a draft. The server normalizes the bytes and assigns object IDs. */
export async function publicationMediaRequest(request: Request, context: PublicationProductContext): Promise<Response> {
  if (!config.experienceHostPublicationApiEnabled) return responseError("NOT_FOUND", 404);
  const productId = (await context.params).productId;
  if (!PRODUCT_ID.test(productId) || new URL(request.url).search) return responseError("NOT_FOUND", 404);
  if (!publicationHostMutationAllowed(request)) return responseError("FORBIDDEN", 403);
  if (request.headers.get("x-experience-photo-rights-confirmed") !== "true") return responseError("PHOTO_RIGHTS_CONFIRMATION_REQUIRED", 422);
  const altText = decodeBase64UrlHeader(request.headers.get("x-experience-photo-alt-text-utf8-base64url")) ?? "";
  const altTextJa = decodeBase64UrlHeader(request.headers.get("x-experience-photo-alt-text-ja-utf8-base64url")) ?? "";
  const placement = request.headers.get("x-experience-media-placement") ?? "GALLERY";
  const publicCreditHeader = request.headers.get("x-experience-photo-credit-utf8-base64url");
  const publicCredit = publicCreditHeader === null ? null : decodeBase64UrlHeader(publicCreditHeader);
  if (altText.trim() === "" || altText.length > 500 || altTextJa.trim() === "" || altTextJa.length > 500
    || placement !== "GALLERY"
    || (publicCreditHeader !== null && publicCredit === null)
    || (publicCredit !== null && (publicCredit.trim() === "" || publicCredit.length > 300))) {
    return responseError("INVALID_INPUT", 400);
  }
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "image/jpeg" && mediaType !== "image/png") return responseError("UNSUPPORTED_FORMAT", 415);
  const prepared = await prepareHost("OWNER");
  if (!prepared.ok) return prepared.response;
  const storage = experiencePublicMediaStorage();
  if (!storage || !prepared.context.readiness) return responseError("SELLER_SETUP_REQUIRED", 409);

  let original: Buffer;
  let processed: Awaited<ReturnType<typeof processGuideCoverImage>>;
  try {
    original = await readGuideCoverInput(request);
    processed = await processGuideCoverImage(original);
  } catch (error) {
    if (error instanceof GuideCoverImageError) {
      const status = error.code === "payload_too_large" ? 413 : error.code === "unsupported_format" ? 415 : 400;
      return responseError(error.code.toUpperCase(), status);
    }
    return responseError("INVALID_INPUT", 400);
  }

  const id = randomUUID();
  const objectKey = `experience-products/${id}.jpg`;
  let stored = false;
  let registered = false;
  try {
    await storage.write(objectKey, processed.bytes);
    stored = true;
    const assetInput: ExperienceHostMediaAssetInput = {
      id, objectKey, sourceRefHash: createHash("sha256").update(original).digest("hex"),
      width: processed.width, height: processed.height, byteSize: processed.bytes.byteLength,
      altText, altTextJa, publicCredit,
    };
    const asset = await prepared.repository.addMedia(prepared.context.actor, productId, assetInput);
    registered = true;
    const product = await productDto(prepared.repository, prepared.context.actor, productId);
    return noStoreJson({
      asset: { ...asset, previewUrl: `/host/api/products/${encodeURIComponent(productId)}/media/${encodeURIComponent(asset.id)}` },
      product,
    }, 201);
  } catch (error) {
    if (stored && !registered) await storage.remove(objectKey).catch(() => undefined);
    return mapStoreError(error);
  }
}

/** Replace the mutable selection for gallery and seller media with an opaque product-version CAS. */
export async function publicationMediaSelectionRequest(request: Request, context: PublicationProductContext): Promise<Response> {
  if (!config.experienceHostPublicationApiEnabled) return responseError("NOT_FOUND", 404);
  const productId = (await context.params).productId;
  if (!PRODUCT_ID.test(productId) || new URL(request.url).search) return responseError("NOT_FOUND", 404);
  if (!publicationHostMutationAllowed(request)) return responseError("FORBIDDEN", 403);
  const body = await parseJson(request);
  if (body instanceof Response) return body;
  if (!exactKeys(body, ["version", "media"]) || !Array.isArray(body.media) || body.media.length > 20) return responseError("INVALID_INPUT", 400);
  const revision = decodeRevision(body.version);
  if (!revision) return responseError("INVALID_INPUT", 400);
  const media: ExperienceHostMediaSelectionInput[] = [];
  for (const item of body.media) {
    if (!isRecord(item) || !exactKeys(item, ["id", "altText", "altTextJa", "publicCredit"])
      || typeof item.id !== "string"
      || typeof item.altText !== "string" || typeof item.altTextJa !== "string"
      || (item.publicCredit !== null && typeof item.publicCredit !== "string")) return responseError("INVALID_INPUT", 400);
    media.push({ id: item.id, altText: item.altText, altTextJa: item.altTextJa, publicCredit: item.publicCredit as string | null });
  }
  const prepared = await prepareHost("OWNER");
  if (!prepared.ok) return prepared.response;
  try {
    await prepared.repository.saveMediaSelection(prepared.context.actor, productId, revision.draft, media);
    return noStoreJson({ product: await productDto(prepared.repository, prepared.context.actor, productId) });
  } catch (error) { return mapStoreError(error); }
}

/** Seller-level profile media is shared by every public product for the authenticated OWNER. */
export async function providerMediaCollectionRequest(request: Request): Promise<Response> {
  if (!config.experienceHostPublicationApiEnabled) return responseError("NOT_FOUND", 404);
  if (new URL(request.url).search) return responseError("NOT_FOUND", 404);
  const prepared = await prepareHost("OWNER");
  if (!prepared.ok) return prepared.response;
  if (request.method === "GET") {
    try { return noStoreJson({ providerMedia: await providerMediaDto(prepared.repository, prepared.context.actor) }); }
    catch (error) { return mapStoreError(error); }
  }
  if (request.method !== "PUT") return responseError("NOT_FOUND", 404);
  if (!publicationHostMutationAllowed(request)) return responseError("FORBIDDEN", 403);
  const body = await parseJson(request);
  if (body instanceof Response || !exactKeys(body, ["version", "media"]) || !Number.isSafeInteger(body.version) || (body.version as number) < 1
    || !Array.isArray(body.media) || body.media.length > 2) return responseError("INVALID_INPUT", 400);
  const media: ExperienceHostProviderMediaSelectionInput[] = [];
  for (const item of body.media) {
    if (!isRecord(item) || !exactKeys(item, ["id", "placement", "altText", "altTextJa", "publicCredit"])
      || typeof item.id !== "string" || typeof item.placement !== "string"
      || !["PROVIDER_PHOTO", "BUSINESS_LOGO"].includes(item.placement)
      || typeof item.altText !== "string" || typeof item.altTextJa !== "string"
      || (item.publicCredit !== null && typeof item.publicCredit !== "string")) return responseError("INVALID_INPUT", 400);
    media.push({
      id: item.id, placement: item.placement as ExperienceHostProviderMediaSelectionInput["placement"],
      altText: item.altText, altTextJa: item.altTextJa, publicCredit: item.publicCredit as string | null,
    });
  }
  try {
    const providerMedia = await prepared.repository.saveProviderMediaSelection(prepared.context.actor, body.version as number, media);
    return noStoreJson({ providerMedia: {
      ...providerMedia,
      assets: providerMedia.assets.map((asset) => ({ ...asset, previewUrl: `/host/api/provider-media/${encodeURIComponent(asset.id)}` })),
    } });
  } catch (error) { return mapStoreError(error); }
}

/** Upload one provider-level photo or business logo after explicit use-specific permission. */
export async function providerMediaUploadRequest(request: Request): Promise<Response> {
  if (!config.experienceHostPublicationApiEnabled) return responseError("NOT_FOUND", 404);
  if (new URL(request.url).search) return responseError("NOT_FOUND", 404);
  if (!publicationHostMutationAllowed(request)) return responseError("FORBIDDEN", 403);
  if (request.headers.get("x-experience-photo-rights-confirmed") !== "true") return responseError("PHOTO_RIGHTS_CONFIRMATION_REQUIRED", 422);
  const altText = decodeBase64UrlHeader(request.headers.get("x-experience-photo-alt-text-utf8-base64url")) ?? "";
  const altTextJa = decodeBase64UrlHeader(request.headers.get("x-experience-photo-alt-text-ja-utf8-base64url")) ?? "";
  const placement = request.headers.get("x-experience-media-placement");
  const mediaVersionHeader = request.headers.get("x-experience-provider-media-version");
  const mediaVersion = mediaVersionHeader && /^\d+$/.test(mediaVersionHeader) ? Number(mediaVersionHeader) : Number.NaN;
  const publicCreditHeader = request.headers.get("x-experience-photo-credit-utf8-base64url");
  const publicCredit = publicCreditHeader === null ? null : decodeBase64UrlHeader(publicCreditHeader);
  if (altText.trim() === "" || altText.length > 500 || altTextJa.trim() === "" || altTextJa.length > 500
    || (placement !== "PROVIDER_PHOTO" && placement !== "BUSINESS_LOGO")
    || !Number.isSafeInteger(mediaVersion) || mediaVersion < 1
    || (publicCreditHeader !== null && publicCredit === null)
    || (publicCredit !== null && (publicCredit.trim() === "" || publicCredit.length > 300))) return responseError("INVALID_INPUT", 400);
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "image/jpeg" && mediaType !== "image/png") return responseError("UNSUPPORTED_FORMAT", 415);
  const prepared = await prepareHost("OWNER");
  if (!prepared.ok) return prepared.response;
  const storage = experiencePublicMediaStorage();
  if (!storage) return responseError("UNAVAILABLE", 503);
  let original: Buffer;
  let processed: Awaited<ReturnType<typeof processGuideCoverImage>>;
  try {
    original = await readGuideCoverInput(request);
    processed = await processGuideCoverImage(original);
  } catch (error) {
    if (error instanceof GuideCoverImageError) {
      const status = error.code === "payload_too_large" ? 413 : error.code === "unsupported_format" ? 415 : 400;
      return responseError(error.code.toUpperCase(), status);
    }
    return responseError("INVALID_INPUT", 400);
  }
  const before = await prepared.repository.getProviderMedia(prepared.context.actor).catch(() => null);
  const old = before?.assets.find((asset) => asset.placement === placement);
  const id = randomUUID();
  const objectKey = `experience-provider-media/${id}.jpg`;
  let stored = false;
  let registered = false;
  try {
    await storage.write(objectKey, processed.bytes);
    stored = true;
    const asset: ExperienceHostProviderMediaAssetInput = {
      id, objectKey, sourceRefHash: createHash("sha256").update(original).digest("hex"),
      width: processed.width, height: processed.height, byteSize: processed.bytes.byteLength,
      placement, altText, altTextJa, publicCredit,
    };
    const profile = await prepared.repository.addProviderMedia(prepared.context.actor, mediaVersion, asset);
    registered = true;
    if (old) await storage.remove(`experience-provider-media/${old.id}.jpg`).catch(() => undefined);
    return noStoreJson({ providerMedia: {
      ...profile,
      assets: profile.assets.map((item) => ({ ...item, previewUrl: `/host/api/provider-media/${encodeURIComponent(item.id)}` })),
    } }, 201);
  } catch (error) {
    if (stored && !registered) await storage.remove(objectKey).catch(() => undefined);
    return mapStoreError(error);
  }
}

export async function providerMediaAssetRequest(request: Request, context: { params: Promise<{ assetId: string }> }): Promise<Response> {
  if (!config.experienceHostPublicationApiEnabled) return responseError("NOT_FOUND", 404);
  const { assetId } = await context.params;
  if (!UUID_V4.test(assetId) || new URL(request.url).search) return responseError("NOT_FOUND", 404);
  const prepared = await prepareHost("OWNER");
  if (!prepared.ok) return prepared.response;
  const storage = experiencePublicMediaStorage();
  if (!storage) return responseError("UNAVAILABLE", 503);
  try {
    if (request.method === "GET") {
      const asset = (await prepared.repository.getProviderMedia(prepared.context.actor)).assets.find((item) => item.id === assetId);
      if (!asset) return responseError("NOT_FOUND", 404);
      const objectKey = `experience-provider-media/${asset.id}.jpg`;
      const bytes = await storage.read(objectKey);
      if (bytes.byteLength !== asset.byteSize) return responseError("UNAVAILABLE", 503);
      return new Response(Uint8Array.from(bytes).buffer, { headers: {
        "cache-control": "private, no-store", "content-type": "image/jpeg", "content-length": String(bytes.byteLength),
        "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", "x-robots-tag": "noindex, nofollow",
      } });
    }
    if (request.method !== "DELETE" || !publicationHostMutationAllowed(request)) return responseError("FORBIDDEN", 403);
    const body = await parseJson(request);
    if (body instanceof Response || !exactKeys(body, ["version"]) || !Number.isSafeInteger(body.version) || (body.version as number) < 1) return responseError("INVALID_INPUT", 400);
    const profile = await prepared.repository.revokeProviderMedia(prepared.context.actor, assetId, body.version as number);
    await storage.remove(`experience-provider-media/${assetId}.jpg`).catch(() => undefined);
    return noStoreJson({ providerMedia: {
      ...profile,
      assets: profile.assets.map((item) => ({ ...item, previewUrl: `/host/api/provider-media/${encodeURIComponent(item.id)}` })),
    } });
  } catch (error) { return mapStoreError(error); }
}

const MANUSCRIPT_LOCALE_KEYS = ["title", "lead", "description", "language", "highlights", "included", "notIncluded", "knowBeforeYouGo", "notSuitableFor", "timeline"] as const;

function validLocaleManuscript(value: unknown): value is Record<string, string | readonly string[]> {
  if (!isRecord(value) || !exactKeys(value, MANUSCRIPT_LOCALE_KEYS)) return false;
  for (const key of ["title", "lead", "description", "language"] as const) {
    if (typeof value[key] !== "string" || value[key].length > (key === "description" ? 8_000 : 1_000)) return false;
  }
  for (const key of ["highlights", "included", "notIncluded", "knowBeforeYouGo", "notSuitableFor"] as const) {
    if (!Array.isArray(value[key]) || value[key].length > 30 || value[key].some((item) => typeof item !== "string" || item.length > 1_000)) return false;
  }
  if (!Array.isArray(value.timeline) || value.timeline.length > 20 || value.timeline.some((item) => !isRecord(item)
    || !exactKeys(item, ["time", "title", "text", "photoIndex"])
    || typeof item.time !== "string" || item.time.length > 80
    || typeof item.title !== "string" || item.title.length > 200
    || typeof item.text !== "string" || item.text.length > 1_000
    || (item.photoIndex !== null && (!Number.isSafeInteger(item.photoIndex) || (item.photoIndex as number) < 0)))) return false;
  return true;
}

/** Produce an uncommitted English draft. The host UI must review and save it through normal product CAS. */
export async function publicationTranslationRequest(request: Request, context: PublicationProductContext): Promise<Response> {
  if (!config.experienceHostPublicationApiEnabled) return responseError("NOT_FOUND", 404);
  const productId = (await context.params).productId;
  if (!PRODUCT_ID.test(productId) || new URL(request.url).search) return responseError("NOT_FOUND", 404);
  if (!publicationHostMutationAllowed(request)) return responseError("FORBIDDEN", 403);
  const parsed = await parseJson(request);
  if (parsed instanceof Response || !exactKeys(parsed, ["japanese"]) || !validLocaleManuscript(parsed.japanese)) return responseError("INVALID_INPUT", 400);
  const prepared = await prepareHost("OWNER");
  if (!prepared.ok) return prepared.response;
  const translator = anthropicTranslator({ timeoutMs: 45_000 });
  if (!translator) return responseError("TRANSLATION_UNAVAILABLE", 503);
  const japanese = parsed.japanese;
  try { await prepared.repository.getProduct(prepared.context.actor, productId); }
  catch (error) { return mapStoreError(error); }
  const sourceFingerprint = createHash("sha256").update(canonicalJson(japanese), "utf8").digest("hex");
  const translated = await translator(experienceManuscriptToEnglish(japanese));
  if (!translated.ok) return responseError("TRANSLATION_UNAVAILABLE", 503);
  let english: unknown;
  try { english = JSON.parse(translated.text); } catch { return responseError("TRANSLATION_UNAVAILABLE", 503); }
  if (!validLocaleManuscript(english)) return responseError("TRANSLATION_UNAVAILABLE", 503);
  return noStoreJson({ sourceFingerprint, english });
}

export async function readPublicationMedia(request: Request, context: PublicationProductContext & { params: Promise<{ productId: string; assetId: string }> }): Promise<Response> {
  if (!config.experienceHostPublicationApiEnabled) return responseError("NOT_FOUND", 404);
  const { productId, assetId } = await context.params;
  if (!PRODUCT_ID.test(productId) || !UUID_V4.test(assetId) || new URL(request.url).search) return responseError("NOT_FOUND", 404);
  const prepared = await prepareHost("READ");
  if (!prepared.ok) return prepared.response;
  const storage = experiencePublicMediaStorage();
  if (!storage) return responseError("UNAVAILABLE", 503);
  try {
    const asset = (await prepared.repository.listMedia(prepared.context.actor, productId)).find((item) => item.id === assetId);
    if (!asset) return responseError("NOT_FOUND", 404);
    const objectKey = `experience-products/${asset.id}.jpg`;
    const bytes = await storage.read(objectKey);
    if (bytes.byteLength !== asset.byteSize) return responseError("UNAVAILABLE", 503);
    return new Response(Uint8Array.from(bytes).buffer, { headers: {
      "cache-control": "private, no-store", "content-type": "image/jpeg", "content-length": String(bytes.byteLength),
      "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", "x-robots-tag": "noindex, nofollow",
    } });
  } catch (error) { return mapStoreError(error); }
}
