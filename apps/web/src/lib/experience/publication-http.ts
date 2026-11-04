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
  type ExperiencePublicationDraftCreateInput,
  type ExperiencePublicationDraftInput,
  type ExperiencePublicationState,
  type JsonValue,
  type ProductSaleTermsInput,
} from "@niho-experience/experience-store";
import { createHash, randomUUID } from "node:crypto";
import { config } from "@/lib/config";
import { noStoreJson } from "@/lib/host/server";
import { ResponseBodyTooLarge, readBoundedJson } from "@/lib/read-bounded-json";
import { experiencePublicationRepository } from "./store-server";
import {
  publicationHostBoundary,
  publicationHostMutationAllowed,
  type PublicationHostContext,
} from "./publication-host-boundary";
import { experiencePublicMediaStorage } from "./public-media-storage";
import { GuideCoverImageError, processGuideCoverImage, readGuideCoverInput } from "@/lib/editor/guide-cover-image";

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
type Action = "read" | "save" | "publish" | "stop" | "readSaleTerms" | "saveSaleTerms";
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

function exactKeys(value: RecordValue, allowed: readonly string[], required: readonly string[] = allowed): boolean {
  return Object.keys(value).every((key) => allowed.includes(key)) && required.every((key) => Object.hasOwn(value, key));
}

function versionPart(value: number | null): string { return value === null ? "0" : String(value); }

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
    && typeof value.unitAmount === "number" && Number.isSafeInteger(value.unitAmount) && value.unitAmount > 0;
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
  const [product, state, termsState, media] = await Promise.all([
    repository.getProduct(actor, productId),
    repository.getState(actor, productId),
    repository.getSaleTerms(actor, productId),
    repository.listMedia(actor, productId),
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

function checksFor(product: { readonly content: Readonly<Record<string, unknown>> }, photosReady: boolean) {
  return { manuscriptReady: projectPublicExperiencePublicationManuscript(product.content as never) !== null, photosReady };
}

function actionOperation(action: Action): "READ" | "EDIT" | "OWNER" {
  if (action === "publish" || action === "stop") return "OWNER";
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
  if (action !== "read" && action !== "readSaleTerms") {
    const parsed = await parseJson(request);
    if (parsed instanceof Response) return parsed;
    body = parsed;
    revision = validActionBody(action, body);
    if (!revision) return responseError("INVALID_INPUT", 400);
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
    if (action === "read") return noStoreJson({ product: await productDto(repository, actor, productId), publicationConsentVersion: config.experiencePublicationConsentVersion });
    if (action === "readSaleTerms") return noStoreJson({ product: await productDto(repository, actor, productId) });
    const product = await repository.getProduct(actor, productId);
    const state = await repository.getState(actor, productId);
    const terms = await repository.getSaleTerms(actor, productId);
    const checks = checksFor(product, (await repository.listMedia(actor, productId)).length > 0);

    if (action === "save") {
      const input = body!.draft as ProductDraftBody;
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
  const altText = request.headers.get("x-experience-photo-alt-text") ?? "";
  const publicCreditHeader = request.headers.get("x-experience-photo-credit");
  const publicCredit = publicCreditHeader === null || publicCreditHeader === "" ? null : publicCreditHeader;
  if (altText.length > 500 || (publicCredit !== null && (publicCredit.trim() === "" || publicCredit.length > 300))) {
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
  try {
    await storage.write(objectKey, processed.bytes);
    stored = true;
    const assetInput: ExperienceHostMediaAssetInput = {
      id, objectKey, sourceRefHash: createHash("sha256").update(original).digest("hex"),
      width: processed.width, height: processed.height, byteSize: processed.bytes.byteLength,
      altText, publicCredit,
    };
    const asset = await prepared.repository.addMedia(prepared.context.actor, productId, assetInput);
    return noStoreJson({ asset: { ...asset, previewUrl: `/host/api/products/${encodeURIComponent(productId)}/media/${encodeURIComponent(asset.id)}` } }, 201);
  } catch (error) {
    if (stored) await storage.remove(objectKey).catch(() => undefined);
    return mapStoreError(error);
  }
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
