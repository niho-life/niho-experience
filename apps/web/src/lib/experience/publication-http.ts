import "server-only";
import { validSaleTerms, type ProductSaleTermsInput } from "@niho-experience/experience-store";
import { config } from "@/lib/config";
import { noStoreJson } from "@/lib/host/server";
import { publicationHostBoundary, publicationHostMutationAllowed } from "./publication-host-boundary";
import { readBoundedJson, ResponseBodyTooLarge } from "@/lib/read-bounded-json";

export type PublicationContext = { params: Promise<{ providerId: string; productId: string }> };
type Action = "read" | "save" | "publish" | "stop" | "preview" | "readSaleTerms" | "saveSaleTerms";
type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => value !== null && typeof value === "object" && !Array.isArray(value);
const version = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const versionOrNull = (value: unknown): value is number | null => value === null || version(value);
const BODY_LIMIT = 256 * 1024;
const TERMS_KEYS = [
  "childPricing", "minimumParticipants", "minimumChargeableParticipants", "privateBooking", "maxPartySize",
  "cancellationPolicy", "cancellationWindowMinutesBeforeStart", "cancellationRefundBasisPoints",
  "minimumAttendance", "bookingQuestions", "conditionsVersion",
] as const;

function exactKeys(value: RecordValue, allowed: readonly string[], required: readonly string[] = allowed): boolean {
  return Object.keys(value).every((key) => allowed.includes(key)) && required.every((key) => Object.hasOwn(value, key));
}

function routeEnabled(): boolean {
  return config.hostConsoleEnabled && config.apiMode === "http" && config.experiencePublicationsEnabled
    && process.env.EXPERIENCE_HOST_PUBLICATION_API_ENABLED === "true";
}

function validDraft(value: unknown): boolean {
  if (!record(value) || !exactKeys(value, ["slug", "publicTitle", "content", "currency", "unitAmount", "cancellationTermsRef"])
    || !["slug", "publicTitle", "currency", "cancellationTermsRef"].every((key) => typeof value[key] === "string")
    || typeof value.unitAmount !== "number" || !Number.isSafeInteger(value.unitAmount) || !record(value.content)) return false;
  return true;
}

function validSaleTermsShape(value: unknown): value is ProductSaleTermsInput {
  if (!record(value) || !exactKeys(value, TERMS_KEYS, [
    "childPricing", "minimumParticipants", "maxPartySize", "cancellationPolicy", "bookingQuestions", "conditionsVersion",
  ])) return false;
  if (value.childPricing !== null && (!record(value.childPricing)
    || !exactKeys(value.childPricing, ["priceYen", "minAge", "maxAge", "adultRequired"]))) return false;
  if (!Array.isArray(value.bookingQuestions)) return false;
  for (const question of value.bookingQuestions) {
    if (!record(question) || !exactKeys(question, ["id", "prompt", "description", "inputType", "required", "options"])
      || !Array.isArray(question.options)) return false;
    for (const option of question.options) {
      if (!record(option) || !exactKeys(option, ["id", "label"])) return false;
    }
  }
  return value.conditionsVersion === null;
}

function publicationBoundaryOperation(action: Action): "READ" | "EDIT" | "OWNER" {
  if (action === "publish" || action === "stop") return "OWNER";
  if (action === "save" || action === "saveSaleTerms") return "EDIT";
  return "READ";
}

async function parseJson(request: Request): Promise<RecordValue | Response> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    return noStoreJson({ error: { code: "INVALID_INPUT" } }, 400);
  }
  try {
    const value = await readBoundedJson(request, BODY_LIMIT, { fatalUtf8: true });
    return record(value) ? value : noStoreJson({ error: { code: "INVALID_INPUT" } }, 400);
  } catch (error) {
    return noStoreJson({ error: { code: "INVALID_INPUT" } }, error instanceof ResponseBodyTooLarge ? 413 : 400);
  }
}

function validBody(action: Action, body: RecordValue): boolean {
  if (action === "save") {
    return exactKeys(body, ["expectedDraftVersion", "expectedStateVersion", "draft"])
      && version(body.expectedDraftVersion) && versionOrNull(body.expectedStateVersion) && validDraft(body.draft);
  }
  if (action === "saveSaleTerms") {
    if (!exactKeys(body, ["expectedDraftVersion", "expectedStateVersion", "expectedSaleTermsVersion", "saleTerms"])
      || !version(body.expectedDraftVersion) || !versionOrNull(body.expectedStateVersion)
      || !versionOrNull(body.expectedSaleTermsVersion) || !validSaleTermsShape(body.saleTerms)) return false;
    try { validSaleTerms(body.saleTerms); return true; }
    catch { return false; }
  }
  if (action === "stop") return exactKeys(body, ["expectedStateVersion"]) && version(body.expectedStateVersion);
  if (action === "publish") {
    return exactKeys(body, ["expectedDraftVersion", "expectedStateVersion", "consentVersion", "accepted"])
      && version(body.expectedDraftVersion) && versionOrNull(body.expectedStateVersion)
      && typeof body.consentVersion === "string" && body.consentVersion.length >= 1 && body.consentVersion.length <= 160
      && typeof body.accepted === "boolean";
  }
  return false;
}

/** Experience-owned BFF. Identity and Connect fields come only from the dedicated A-contract boundary. */
export async function publicationRequest(request: Request, context: PublicationContext, action: Action): Promise<Response> {
  if (!routeEnabled()) return noStoreJson({ error: { code: "NOT_FOUND" } }, 404);
  const { providerId, productId } = await context.params;
  const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/;
  if (!idPattern.test(providerId) || !idPattern.test(productId) || new URL(request.url).search) {
    return noStoreJson({ error: { code: "NOT_FOUND" } }, 404);
  }
  if (!publicationHostMutationAllowed(request)) return noStoreJson({ error: { code: "FORBIDDEN" } }, 403);
  if (!["read", "preview", "readSaleTerms"].includes(action)) {
    const parsed = await parseJson(request);
    if (parsed instanceof Response) return parsed;
    if (!validBody(action, parsed)) return noStoreJson({ error: { code: "INVALID_INPUT" } }, 400);
    if (action === "publish") {
      if (parsed.accepted !== true) return noStoreJson({ error: { code: "PUBLICATION_BLOCKED", blockers: ["CONSENT_REQUIRED"] } }, 422);
      if (parsed.consentVersion !== config.experiencePublicationConsentVersion) {
        return noStoreJson({ error: { code: "PUBLICATION_BLOCKED", blockers: ["CONSENT_OUTDATED"] } }, 422);
      }
    }
  }
  return publicationHostBoundary(providerId, publicationBoundaryOperation(action));
}
