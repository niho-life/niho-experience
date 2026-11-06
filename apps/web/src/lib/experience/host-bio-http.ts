import "server-only";
import {
  HOST_BIO_CONSENT_VERSION,
  HOST_BIO_LIMITS,
  StoreAccessDeniedError,
  StoreConflictError,
  StoreValidationError,
  hostBioTextIssue,
  normalizeHostBioText,
} from "@niho-experience/experience-store";
import { noStoreJson } from "@/lib/host/server";
import { ResponseBodyTooLarge, readBoundedJson } from "@/lib/read-bounded-json";
import { anthropicTranslator } from "@/lib/translation/anthropic";
import { hostBioToEnglish } from "@/lib/translation/prompts";
import { publicationHostBoundary, publicationHostMutationAllowed } from "./publication-host-boundary";
import { providerHostBioRepository } from "./store-server";

/*
 * ホスト紹介文 (#146) host API: GET/PUT/DELETE /host/api/host-bio and POST /host/api/host-bio/translation.
 * Same boundary as the seller disclosure (current NIHO identity → mapped Experience OWNER, same-origin
 * writes, strict JSON, private no-store). Bio text never goes to logs, metrics or URLs.
 */

// 600 + 1500 characters, each at most 6 bytes as a JSON \u escape, fit with room to spare.
const BODY_LIMIT = 16 * 1024;
type JsonObject = Record<string, unknown>;

const error = (code: string, status: number) => noStoreJson({ error: { code } }, status);
const isObject = (value: unknown): value is JsonObject => value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value: JsonObject, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const positiveVersion = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 1;

async function bodyOf(request: Request): Promise<JsonObject | Response> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") return error("INVALID_INPUT", 400);
  try {
    const value: unknown = await readBoundedJson(request, BODY_LIMIT, { fatalUtf8: true });
    return isObject(value) ? value : error("INVALID_INPUT", 400);
  } catch (caught) {
    return error("INVALID_INPUT", caught instanceof ResponseBodyTooLarge ? 413 : 400);
  }
}

function storeError(caught: unknown): Response {
  if (caught instanceof StoreAccessDeniedError) return error("FORBIDDEN", 403);
  if (caught instanceof StoreConflictError) return error("VERSION_CONFLICT", 409);
  if (caught instanceof StoreValidationError) return error("INVALID_INPUT", 422);
  return error("UNAVAILABLE", 503);
}

async function prepared() {
  const boundary = await publicationHostBoundary("OWNER");
  if (!boundary.ok) return boundary;
  const repository = providerHostBioRepository();
  return repository ? { ok: true as const, actor: boundary.value.actor, repository } : { ok: false as const, response: error("UNAVAILABLE", 503) };
}

export async function getHostBio(request: Request): Promise<Response> {
  if (new URL(request.url).search) return error("INVALID_INPUT", 400);
  const context = await prepared();
  if (!context.ok) return context.response;
  try {
    return noStoreJson({ hostBio: await context.repository.getForOwner(context.actor), consentVersion: HOST_BIO_CONSENT_VERSION });
  } catch (caught) { return storeError(caught); }
}

export async function putHostBio(request: Request): Promise<Response> {
  if (!publicationHostMutationAllowed(request)) return error("FORBIDDEN", 403);
  if (new URL(request.url).search) return error("INVALID_INPUT", 400);
  const body = await bodyOf(request);
  if (body instanceof Response) return body;
  if (!exactKeys(body, ["bioJa", "bioEn", "expectedVersion", "consentVersion"])) return error("INVALID_INPUT", 400);
  if (typeof body.bioJa !== "string" || (body.bioEn !== null && typeof body.bioEn !== "string")) return error("INVALID_INPUT", 400);
  if (body.expectedVersion !== null && !positiveVersion(body.expectedVersion)) return error("INVALID_INPUT", 400);
  if (body.consentVersion !== HOST_BIO_CONSENT_VERSION) return error("INVALID_INPUT", 400);
  const context = await prepared();
  if (!context.ok) return context.response;
  try {
    const saved = await context.repository.save(context.actor, {
      bioJa: body.bioJa, bioEn: body.bioEn, expectedVersion: body.expectedVersion, consentVersion: body.consentVersion,
    });
    return noStoreJson({ hostBio: saved });
  } catch (caught) { return storeError(caught); }
}

export async function deleteHostBio(request: Request): Promise<Response> {
  if (!publicationHostMutationAllowed(request)) return error("FORBIDDEN", 403);
  if (new URL(request.url).search) return error("INVALID_INPUT", 400);
  const body = await bodyOf(request);
  if (body instanceof Response) return body;
  if (!exactKeys(body, ["expectedVersion"]) || !positiveVersion(body.expectedVersion)) return error("INVALID_INPUT", 400);
  const context = await prepared();
  if (!context.ok) return context.response;
  try {
    return noStoreJson({ hostBio: await context.repository.withdraw(context.actor, body.expectedVersion) });
  } catch (caught) { return storeError(caught); }
}

/** An English draft of the Japanese bio for the OWNER to check. Nothing is saved. */
export async function translateHostBio(request: Request): Promise<Response> {
  if (!publicationHostMutationAllowed(request)) return error("FORBIDDEN", 403);
  if (new URL(request.url).search) return error("INVALID_INPUT", 400);
  const body = await bodyOf(request);
  if (body instanceof Response) return body;
  if (!exactKeys(body, ["bioJa"]) || typeof body.bioJa !== "string") return error("INVALID_INPUT", 400);
  const japanese = normalizeHostBioText(body.bioJa);
  if (hostBioTextIssue(japanese, "ja")) return error("INVALID_INPUT", 400);
  const context = await prepared();
  if (!context.ok) return context.response;
  // The boundary resolves the mapped OWNER; the Store confirms the current OWNER membership before any text leaves.
  try { await context.repository.getForOwner(context.actor); }
  catch (caught) { return storeError(caught); }
  const translator = anthropicTranslator({ timeoutMs: 45_000 });
  if (!translator) return error("TRANSLATION_UNAVAILABLE", 503);
  const translated = await translator(hostBioToEnglish(japanese), { maxLength: HOST_BIO_LIMITS.en });
  if (!translated.ok) return error("TRANSLATION_UNAVAILABLE", 503);
  const english = normalizeHostBioText(translated.text);
  if (hostBioTextIssue(english, "en")) return error("TRANSLATION_UNAVAILABLE", 503);
  return noStoreJson({ bioEn: english });
}
