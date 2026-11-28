import "server-only";
import {
  ExperiencePublicationBlockedError,
  isSelling,
  StoreAccessDeniedError,
  StoreConflictError,
  StoreNotFoundError,
  StoreValidationError,
  validSaleTerms,
  publicationFaqIssue,
  publicationManuscriptFingerprint,
  publicationManuscriptReview,
  validPublicationLocaleManuscript,
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
  salesKindOf,
  type AgentPublishCheck,
} from "@niho-experience/experience-store";
import { createHash, randomUUID } from "node:crypto";
import { config } from "@/lib/config";
import { noStoreJson } from "@/lib/host/server";
import { ResponseBodyTooLarge, readBoundedJson } from "@/lib/read-bounded-json";
import { retrievePlatformAccount } from "@niho-experience/experience-payments";
import { experiencePublicationRepository, guestMeetingGuideRepository, managedExperienceSalesRepository, productClassificationRepository, providerAgentSales, providerSellerDisclosureRepository } from "./store-server";
import {
  publicationHostBoundary,
  publicationHostMutationAllowed,
  type PublicationHostContext,
} from "./publication-host-boundary";
import { requestedProviderId } from "./provider-context";
import { experiencePublicMediaStorage } from "./public-media-storage";
import { GuideCoverImageError, processGuideCoverImage, readGuideCoverInput } from "@/lib/guide-cover-image";
import { anthropicTranslator } from "@/lib/translation/anthropic";
import { EXPERIENCE_MANUSCRIPT_TRANSLATION_MAX_LENGTH, experienceManuscriptToEnglish, experienceManuscriptToJapanese } from "@/lib/translation/prompts";

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
type Action = "read" | "save" | "publish" | "publishPage" | "openBooking" | "stopBooking" | "stop" | "readSaleTerms" | "saveSaleTerms" | "readBookingGuide" | "saveBookingGuide" | "readClassification" | "saveClassification";
const BODY_LIMIT = 256 * 1024;
const NOT_FOUND = { code: "NOT_FOUND", status: 404 } as const;
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

/** Optional FAQ (English top-level, Japanese under `ja`): absent is fine, a written one must be complete. */
function validContentFaq(content: RecordValue): boolean {
  if (content.faq !== undefined && publicationFaqIssue(content.faq) !== null) return false;
  return !isRecord(content.ja) || content.ja.faq === undefined || publicationFaqIssue(content.ja.faq) === null;
}

/** 日本語のみで公開する商品（#59）は、日本語サイト（EXPERIENCE_JAPANESE_SITE_ENABLED）が有効な環境でだけ保存できる。 */
function japaneseOnlyAllowed(content: RecordValue): boolean {
  return content.japaneseOnly === undefined || content.japaneseOnly === false || (content.japaneseOnly === true && config.japaneseSiteEnabled);
}

function validDraft(value: unknown): value is ProductDraftBody {
  return isRecord(value)
    && exactKeys(value, ["slug", "publicTitle", "content", "currency", "unitAmount"])
    && typeof value.slug === "string" && value.slug.length >= 1 && value.slug.length <= 160
    && typeof value.publicTitle === "string" && value.publicTitle.length >= 1 && value.publicTitle.length <= 300
    && isRecord(value.content)
    && validContentFaq(value.content)
    && japaneseOnlyAllowed(value.content)
    && !(value.content.japaneseOnly === true && value.content.englishOnly === true)
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

/**
 * `sales` says what the operation needs beyond membership (docs/host-publication.md). "readiness": the product screens
 * return the publication blockers the store reads from the readiness snapshot (getPublicationBlockers, saveDraft,
 * saveSaleTerms, publish, createDraft), so they refresh it first, as before. "optional" does the same when the provider
 * has a seller profile and nothing at all when it has none (a draft needs no seller, #704; publish and stop stay on
 * "readiness"). "none": membership only, no Stripe call and no snapshot write. (The NIHO path resolves the whole sale
 * side regardless, and so still refreshes.)
 */
async function prepareHost(operation: "READ" | "EDIT" | "OWNER", providerId: string | null, sales: "readiness" | "optional" | "none"): Promise<
  { readonly ok: true; readonly context: PublicationHostContext<"none">; readonly repository: NonNullable<ReturnType<typeof experiencePublicationRepository>> }
  | { readonly ok: false; readonly response: Response }
> {
  const boundary = sales === "readiness"
    ? await publicationHostBoundary(operation, { providerId })
    : await publicationHostBoundary(operation, { providerId, sales });
  if (!boundary.ok) return boundary;
  const repository = experiencePublicationRepository();
  if (!repository) return { ok: false, response: responseError("UNAVAILABLE", 503) };
  try {
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

/**
 * The image URLs the host screen puts in `<img src>`. They name the provider (`?providerId=`): an owner of two or more
 * hosts would otherwise get 409 PROVIDER_REQUIRED for every image (#709). The id is the actor's, already checked.
 */
const productMediaUrl = (providerId: string, productId: string, assetId: string) =>
  `/host/api/products/${encodeURIComponent(productId)}/media/${encodeURIComponent(assetId)}?providerId=${encodeURIComponent(providerId)}`;
const providerMediaUrl = (providerId: string, assetId: string) =>
  `/host/api/provider-media/${encodeURIComponent(assetId)}?providerId=${encodeURIComponent(providerId)}`;

async function productDto(repository: NonNullable<ReturnType<typeof experiencePublicationRepository>>, actor: PublicationHostContext["actor"], productId: string) {
  const managedSales = managedExperienceSalesRepository();
  const [product, state, termsState, media, publicationNeedsUpdate, offers, salesPlan] = await Promise.all([
    repository.getProduct(actor, productId),
    repository.getState(actor, productId),
    repository.getSaleTerms(actor, productId),
    repository.listMedia(actor, productId),
    repository.hasPendingPublicationChanges(actor, productId),
    repository.listActiveSaleOffers(actor, productId),
    managedSales?.get(actor.providerId, productId) ?? null,
  ]);
  const gallery = media.filter((asset) => asset.placement === "GALLERY");
  const photosReady = gallery.length > 0 && gallery.every((asset) => asset.altText.trim() !== "" && asset.altTextJa.trim() !== "");
  const agentSales = await agentSalesOffer(repository, actor, salesPlan);
  const publicationBlockers = await repository.getPublicationBlockers(
    actor,
    productId,
    checksFor(product.content, photosReady, product.publicTitle),
    config.experiencePublicationConsentVersion,
  );
  const pageBlockers = await repository.getPublicationBlockers(
    actor,
    productId,
    checksFor(product.content, photosReady, product.publicTitle),
    null,
    "PAGE",
  );
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
    publicationBlockers,
    // The same reasons split in two (#705): what stops the public page, and what only stops bookings from opening.
    pageBlockers,
    bookingBlockers: publicationBlockers.filter((blocker) => !pageBlockers.includes(blocker)),
    // Actually taking bookings: a booking version and the listing is not stopped, suspended or awaiting restart.
    bookingOpen: isSelling(state),
    draft: {
      slug: product.slug,
      publicTitle: product.publicTitle,
      content: product.content,
      currency: product.currency,
      unitAmount: product.unitAmount,
    },
    sellerDisplayName: product.seller?.sellerDisplayName ?? null,
    saleTerms: termsState.saleTerms,
    salesPlan: salesPlan ? {
      current: { revision: salesPlan.current.revision, plan: salesPlan.current.plan,
        feeBasisPoints: salesPlan.current.feeBasisPoints, agreementVersion: salesPlan.current.agreementVersion,
        chargeMode: salesPlan.current.chargeMode, sellerParty: salesPlan.current.sellerParty },
      phase: salesPlan.phase,
      pending: salesPlan.pending ? { revision: salesPlan.pending.revision, plan: salesPlan.pending.plan,
        feeBasisPoints: salesPlan.pending.feeBasisPoints, agreementVersion: salesPlan.pending.agreementVersion,
        chargeMode: salesPlan.pending.chargeMode, sellerParty: salesPlan.pending.sellerParty } : null,
      transitionCommandId: salesPlan.transitionCommandId,
      version: salesPlan.version,
    } : null,
    ownerSalesPlanAgreementVersion: process.env.EXPERIENCE_OWNER_SALES_PLAN_AGREEMENT_VERSION ?? null,
    // 代理受領 (#725): what the "サポート 15%（NIHO が代金を受け取る）" choice shows. Null with the flag off, and for a host with a seller profile.
    agentSales,
    offers,
    media: media.map((asset) => ({
      ...asset,
      previewUrl: productMediaUrl(actor.providerId, product.id, asset.id),
    })),
  };
}

/**
 * The choice of 代理受領 (#725) as the host screen shows it: the configured agreement version, the receiving party's name, the delay, and whether
 * the host can choose now (no seller profile, a public seller disclosure to sell under). Null while the flag is off or when the host has a seller profile.
 */
async function agentSalesOffer(repository: NonNullable<ReturnType<typeof experiencePublicationRepository>>, actor: PublicationHostContext["actor"], salesPlan: Awaited<ReturnType<NonNullable<ReturnType<typeof managedExperienceSalesRepository>>["get"]>> | null) {
  if (!config.hostAgentSalesEnabled || !config.hostAccountsEnabled) return null;
  // A host that has since registered its own Stripe account (3c-1) keeps the state of a product that is still sold with 代理受領 (it is shown, not offered again).
  const hasSeller = await repository.providerHasSellerProfile(actor.providerId);
  const isAgentPlan = salesPlan !== null && salesKindOf({ chargeMode: salesPlan.current.chargeMode, salesPlan: salesPlan.current.plan,
    sellerParty: salesPlan.current.sellerParty, feeBasisPoints: salesPlan.current.feeBasisPoints }) === "AGENT_15";
  if (hasSeller && !isAgentPlan) return null;
  const disclosures = providerSellerDisclosureRepository();
  const disclosure = disclosures ? (await disclosures.getForOwner(actor, { agentSales: true }).catch(() => null))?.disclosure ?? null : null;
  // For an agent plan: does the OWNER's consent still count, and which name does the plan sell under (the screen offers a new choice when either differs)?
  const consentCounted = isAgentPlan ? await providerAgentSales()?.consentCounts(actor.providerId, salesPlan.current.sellerNihoAccountRef).catch(() => undefined) : undefined;
  return {
    agreementVersion: config.hostAgentSalesAgreementVersion,
    receiverName: config.hostAgentReceiverName,
    payoutDelayDays: config.hostAgentPayoutDelayDays,
    sellerName: disclosure?.method === "NATIVE" ? disclosure.sellerDisplayName : null,
    ...(hasSeller ? { choosable: false as const } : {}),
    ...(isAgentPlan ? { planSellerName: salesPlan.current.sellerDisplayName } : {}),
    ...(consentCounted === undefined ? {} : { consentCounted }),
  };
}

async function providerMediaDto(repository: NonNullable<ReturnType<typeof experiencePublicationRepository>>, actor: PublicationHostContext["actor"]) {
  const profile = await repository.getProviderMedia(actor);
  return {
    ...profile,
    assets: profile.assets.map((asset) => ({
      ...asset,
      previewUrl: providerMediaUrl(actor.providerId, asset.id),
    })),
  };
}

function checksFor(content: Readonly<Record<string, unknown>>, photosReady: boolean, publicTitle: string) {
  const review = publicationManuscriptReview(content, publicTitle);
  return { manuscriptReady: review.publicContentReady && review.ownerConfirmed, photosReady };
}

/**
 * Publish and stop need the seller and the readiness snapshot. The other product screens read publication blockers
 * (from the snapshot when the provider has a seller; "SELLER_REQUIRED" when it has none, #704); classification and the
 * booking guide do not need the sale side at all.
 */
function actionSales(action: Action): "readiness" | "optional" | "none" {
  if (action === "readClassification" || action === "saveClassification" || action === "readBookingGuide" || action === "saveBookingGuide") return "none";
  // The page alone needs no seller (#705): the readiness is read only when there is a seller profile. Stopping bookings
  // must work while Stripe is down, so it asks for no readiness at all.
  if (action === "publishPage") return "optional";
  if (action === "stopBooking") return "none";
  // 代理受領 (#725): opening bookings needs no seller profile or payout account for a host that sells that way. "optional" reads the readiness
  // only when the host has a seller profile, so every other host is checked exactly as before.
  // Stopping the page, and the older `publish` (page and bookings together), follow the same rule: a host with no seller profile can stop its page.
  if ((action === "openBooking" || action === "publish" || action === "stop") && config.hostAgentSalesEnabled && config.hostAccountsEnabled) return "optional";
  return action === "publish" || action === "openBooking" || action === "stop" ? "readiness" : "optional";
}

function actionOperation(action: Action): "READ" | "EDIT" | "OWNER" {
  if (action === "publish" || action === "publishPage" || action === "openBooking" || action === "stopBooking" || action === "stop" || action === "readBookingGuide" || action === "saveBookingGuide" || action === "readClassification" || action === "saveClassification") return "OWNER";
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
  if (action === "stop" || action === "stopBooking" || action === "publishPage") return exactKeys(body, ["version"]) ? decodeRevision(body.version) : null;
  if (action === "publish" || action === "openBooking") {
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
  const requested = requestedProviderId(request, NOT_FOUND); if (!requested.ok) return requested.response;
  let body: RecordValue | null = null;
  if (action === "create") {
    const parsed = await parseJson(request);
    if (parsed instanceof Response) return parsed;
    body = parsed;
    if (!validDraft(body)) return responseError("INVALID_INPUT", 400);
  }
  const prepared = await prepareHost(action === "create" ? "OWNER" : "READ", requested.providerId, "optional");
  if (!prepared.ok) return prepared.response;
  try {
    if (action === "list") {
      const products = await prepared.repository.listProducts(prepared.context.actor);
      const items = await Promise.all(products.map((product) => productDto(prepared.repository, prepared.context.actor, product.id)));
      return noStoreJson({ products: items, publicationConsentVersion: config.experiencePublicationConsentVersion });
    }
    // A provider with a seller must have a usable one; a provider with none drafts a product that has no seller.
    if (prepared.context.provider !== null
      && (!prepared.context.readiness || !prepared.context.readiness.accountUsable || !prepared.context.readiness.sellerDisplayReady)) {
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
  if (!PRODUCT_ID.test(productId)) return responseError("NOT_FOUND", 404);
  const requested = requestedProviderId(request, NOT_FOUND); if (!requested.ok) return requested.response;
  if (!publicationHostMutationAllowed(request)) return responseError("FORBIDDEN", 403);

  let body: RecordValue | null = null;
  let revision: ProductRevision | null = null;
  if (action !== "read" && action !== "readSaleTerms" && action !== "readBookingGuide" && action !== "readClassification") {
    const parsed = await parseJson(request);
    if (parsed instanceof Response) return parsed;
    body = parsed;
    if (action === "saveClassification") {
      if (!exactKeys(body, ["classification"])) return responseError("INVALID_INPUT", 400);
    } else if (action === "saveBookingGuide") {
      if (!exactKeys(body, ["expectedVersion", "guide"])
        || (body.expectedVersion !== null && (!Number.isSafeInteger(body.expectedVersion) || Number(body.expectedVersion) < 1))) {
        return responseError("INVALID_INPUT", 400);
      }
      try { validateGuestMeetingGuide(body.guide); } catch { return responseError("INVALID_INPUT", 400); }
    } else {
      revision = validActionBody(action, body);
      if (!revision) return responseError("INVALID_INPUT", 400);
    }
    if (action === "publish" || action === "openBooking") {
      if (body.accepted !== true) return responseError("PUBLICATION_BLOCKED", 422, { blockers: ["CONSENT_REQUIRED"] });
      if (body.consentVersion !== config.experiencePublicationConsentVersion) {
        return responseError("PUBLICATION_BLOCKED", 422, { blockers: ["CONSENT_OUTDATED"] });
      }
    }
  }

  const prepared = await prepareHost(actionOperation(action), requested.providerId, actionSales(action));
  if (!prepared.ok) return prepared.response;
  const { repository } = prepared;
  const actor = prepared.context.actor;
  try {
    if (action === "readClassification" || action === "saveClassification") {
      const classifications = productClassificationRepository();
      if (!classifications) return responseError("UNAVAILABLE", 503);
      if (action === "readClassification") return noStoreJson({ classification: await classifications.readForOwner(actor, productId) });
      return noStoreJson({ classification: await classifications.saveForOwner(actor, productId, body!.classification) });
    }
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
    if (action === "publish" || action === "openBooking") {
      // 代理受領 (#725): a product whose sales-plan revision is the agent plan is not judged by the host's payout account or readiness. NIHO's own
      // platform account is read from Stripe now, and the store checks the consent and the public seller disclosure.
      const salesPlan = config.hostAgentSalesEnabled ? await managedExperienceSalesRepository()?.get(actor.providerId, productId) ?? null : null;
      const agent = salesPlan !== null && salesKindOf({ chargeMode: salesPlan.current.chargeMode, salesPlan: salesPlan.current.plan,
        sellerParty: salesPlan.current.sellerParty, feeBasisPoints: salesPlan.current.feeBasisPoints }) === "AGENT_15";
      let agentCheck: AgentPublishCheck | undefined;
      if (agent) {
        const platformKey = process.env.EXPERIENCE_STRIPE_PLATFORM_SECRET_KEY;
        const platformAccount = salesPlan!.current.stripeAccountRef;
        let accountCheck: AgentPublishCheck["accountCheck"] = null;
        try {
          if (platformKey) {
            const account = await retrievePlatformAccount({ expectedAccountId: platformAccount, platformStripeKey: platformKey });
            if (account.chargesEnabled && account.detailsSubmitted && account.country === "JP" && account.defaultCurrency === "JPY") {
              accountCheck = { stripeConnectAccountRef: platformAccount, checkedAtUtc: new Date().toISOString() };
            }
          }
        } catch { return responseError("READINESS_UNAVAILABLE", 502); }
        agentCheck = { agreementVersion: config.hostAgentSalesAgreementVersion, accountCheck };
      } else if (!prepared.context.readiness?.connectReady) return responseError("PUBLICATION_BLOCKED", 422, { blockers: ["CONNECT_NOT_READY"] });
      const currentTermsVersion = terms.saleTerms?.version ?? null;
      if (currentTermsVersion !== revision!.saleTerms) return responseError("VERSION_CONFLICT", 409);
      await (action === "openBooking" ? repository.openBooking : repository.publish).call(repository, actor, productId, {
        expectedDraftVersion: revision!.draft,
        expectedStateVersion: revision!.state,
        expectedSaleTermsVersion: revision!.saleTerms,
        consentVersion: config.experiencePublicationConsentVersion,
        checks,
        ...(agentCheck ? { agentCheck } : {}),
      });
      return noStoreJson({ product: await productDto(repository, actor, productId) });
    }
    if (action === "publishPage") {
      // The page alone (#705): no seller or payout account needed. While bookings are open the store also checks the
      // booking blockers and moves the sale version with the page.
      const currentTermsVersion = terms.saleTerms?.version ?? null;
      if (currentTermsVersion !== revision!.saleTerms) return responseError("VERSION_CONFLICT", 409);
      await repository.publishPage(actor, productId, {
        expectedDraftVersion: revision!.draft,
        expectedStateVersion: revision!.state,
        expectedSaleTermsVersion: revision!.saleTerms,
        checks,
      });
      return noStoreJson({ product: await productDto(repository, actor, productId) });
    }
    if (action === "stopBooking") {
      if (state?.version !== revision!.state) return responseError("VERSION_CONFLICT", 409);
      await repository.stopBooking(actor, productId, state.version);
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
  if (!PRODUCT_ID.test(productId)) return responseError("NOT_FOUND", 404);
  const requested = requestedProviderId(request, NOT_FOUND); if (!requested.ok) return requested.response;
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
  const prepared = await prepareHost("OWNER", requested.providerId, "optional");
  if (!prepared.ok) return prepared.response;
  const storage = experiencePublicMediaStorage();
  if (!storage) return responseError("SELLER_SETUP_REQUIRED", 409);

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
    if (asset.id !== id) await storage.remove(objectKey).catch(() => undefined);
    const product = await productDto(prepared.repository, prepared.context.actor, productId);
    return noStoreJson({
      asset: { ...asset, previewUrl: productMediaUrl(prepared.context.actor.providerId, productId, asset.id) },
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
  if (!PRODUCT_ID.test(productId)) return responseError("NOT_FOUND", 404);
  const requested = requestedProviderId(request, NOT_FOUND); if (!requested.ok) return requested.response;
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
  const prepared = await prepareHost("OWNER", requested.providerId, "optional");
  if (!prepared.ok) return prepared.response;
  try {
    await prepared.repository.saveMediaSelection(prepared.context.actor, productId, revision.draft, media);
    return noStoreJson({ product: await productDto(prepared.repository, prepared.context.actor, productId) });
  } catch (error) { return mapStoreError(error); }
}

/** Seller-level profile media is shared by every public product for the authenticated OWNER. */
export async function providerMediaCollectionRequest(request: Request): Promise<Response> {
  if (!config.experienceHostPublicationApiEnabled) return responseError("NOT_FOUND", 404);
  const requested = requestedProviderId(request, NOT_FOUND); if (!requested.ok) return requested.response;
  const prepared = await prepareHost("OWNER", requested.providerId, "none");
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
      assets: providerMedia.assets.map((asset) => ({ ...asset, previewUrl: providerMediaUrl(prepared.context.actor.providerId, asset.id) })),
    } });
  } catch (error) { return mapStoreError(error); }
}

/** Upload one provider-level photo or business logo after explicit use-specific permission. */
export async function providerMediaUploadRequest(request: Request): Promise<Response> {
  if (!config.experienceHostPublicationApiEnabled) return responseError("NOT_FOUND", 404);
  const requested = requestedProviderId(request, NOT_FOUND); if (!requested.ok) return requested.response;
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
  const prepared = await prepareHost("OWNER", requested.providerId, "none");
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
      assets: profile.assets.map((item) => ({ ...item, previewUrl: providerMediaUrl(prepared.context.actor.providerId, item.id) })),
    } }, 201);
  } catch (error) {
    if (stored && !registered) await storage.remove(objectKey).catch(() => undefined);
    return mapStoreError(error);
  }
}

export async function providerMediaAssetRequest(request: Request, context: { params: Promise<{ assetId: string }> }): Promise<Response> {
  if (!config.experienceHostPublicationApiEnabled) return responseError("NOT_FOUND", 404);
  const { assetId } = await context.params;
  if (!UUID_V4.test(assetId)) return responseError("NOT_FOUND", 404);
  const requested = requestedProviderId(request, NOT_FOUND); if (!requested.ok) return requested.response;
  const prepared = await prepareHost("OWNER", requested.providerId, "none");
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
      assets: profile.assets.map((item) => ({ ...item, previewUrl: providerMediaUrl(prepared.context.actor.providerId, item.id) })),
    } });
  } catch (error) { return mapStoreError(error); }
}

const faqLength = (manuscript: Readonly<Record<string, unknown>>): number => Array.isArray(manuscript.faq) ? manuscript.faq.length : 0;

/** Produce an uncommitted English draft. The host UI must review and save it through normal product CAS. */
export async function publicationTranslationRequest(request: Request, context: PublicationProductContext): Promise<Response> {
  if (!config.experienceHostPublicationApiEnabled) return responseError("NOT_FOUND", 404);
  const productId = (await context.params).productId;
  if (!PRODUCT_ID.test(productId)) return responseError("NOT_FOUND", 404);
  const requested = requestedProviderId(request, NOT_FOUND); if (!requested.ok) return requested.response;
  if (!publicationHostMutationAllowed(request)) return responseError("FORBIDDEN", 403);
  const parsed = await parseJson(request);
  // Exactly one of the two: the Japanese to translate into English, or the English to translate into Japanese.
  if (parsed instanceof Response) return responseError("INVALID_INPUT", 400);
  const toJapanese = exactKeys(parsed, ["english"]);
  if (!toJapanese && !exactKeys(parsed, ["japanese"])) return responseError("INVALID_INPUT", 400);
  const source = toJapanese ? parsed.english : parsed.japanese;
  if (!validPublicationLocaleManuscript(source)) return responseError("INVALID_INPUT", 400);
  const prepared = await prepareHost("OWNER", requested.providerId, "none");
  if (!prepared.ok) return prepared.response;
  const translator = anthropicTranslator({ timeoutMs: 45_000 });
  if (!translator) return responseError("TRANSLATION_UNAVAILABLE", 503);
  try { await prepared.repository.getProduct(prepared.context.actor, productId); }
  catch (error) { return mapStoreError(error); }
  const sourceFingerprint = publicationManuscriptFingerprint(source);
  const translated = await translator(toJapanese ? experienceManuscriptToJapanese(source) : experienceManuscriptToEnglish(source), { maxLength: EXPERIENCE_MANUSCRIPT_TRANSLATION_MAX_LENGTH });
  if (!translated.ok) return responseError("TRANSLATION_UNAVAILABLE", 503);
  let result: unknown;
  try { result = JSON.parse(translated.text); } catch { return responseError("TRANSLATION_UNAVAILABLE", 503); }
  // The draft must keep the same FAQ rows as the source (none, or one translated row per source row).
  if (!validPublicationLocaleManuscript(result) || faqLength(result) !== faqLength(source)) return responseError("TRANSLATION_UNAVAILABLE", 503);
  return noStoreJson(toJapanese ? { sourceFingerprint, japanese: result } : { sourceFingerprint, english: result });
}

export async function readPublicationMedia(request: Request, context: PublicationProductContext & { params: Promise<{ productId: string; assetId: string }> }): Promise<Response> {
  if (!config.experienceHostPublicationApiEnabled) return responseError("NOT_FOUND", 404);
  const { productId, assetId } = await context.params;
  if (!PRODUCT_ID.test(productId) || !UUID_V4.test(assetId)) return responseError("NOT_FOUND", 404);
  const requested = requestedProviderId(request, NOT_FOUND); if (!requested.ok) return requested.response;
  const prepared = await prepareHost("READ", requested.providerId, "none");
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
