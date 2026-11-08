import "server-only";
import { StoreValidationError, type ArticleAuthorityRepository } from "@niho-experience/experience-store";
import { GoogleAuth } from "google-auth-library";
import { config } from "@/lib/config";
import { articleAuthorityRepository } from "@/lib/experience/store-server";
import { verifyGoogleServiceIdentity, type GoogleServiceTokenVerifier } from "@/lib/google-service-identity";
import { readBoundedJson } from "@/lib/read-bounded-json";

const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const USER_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const BODY_LIMIT = 4 * 1024;
const RESPONSE_LIMIT = 64 * 1024;
const googleAuth = new GoogleAuth();

export interface NihoArticleAuthorityResult {
  readonly version: 1;
  readonly writer: boolean;
  readonly links: readonly { readonly providerId: string; readonly inviterNihoUserId: string }[];
}

export interface ArticleAuthorityDependencies {
  readonly repository: ArticleAuthorityRepository;
  readonly checkNiho: (writerNihoUserId: string, providerIds: readonly string[]) => Promise<NihoArticleAuthorityResult>;
}

export function articleAuthorityJson(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff", "x-robots-tag": "noindex, nofollow" } });
}

export async function loadArticleAuthority(
  request: Pick<Request, "headers">,
  overrides: Readonly<{ verifier?: GoogleServiceTokenVerifier; repository?: () => ArticleAuthorityRepository | null }> = {},
): Promise<{ ok: true; dependencies: ArticleAuthorityDependencies } | { ok: false; response: Response }> {
  if (!config.articleAuthorityApiEnabled) return { ok: false, response: articleAuthorityJson({ error: "not_found" }, 404) };
  let identity;
  try {
    identity = await verifyGoogleServiceIdentity(request, {
      audience: config.articleAuthorityAudience,
      serviceAccountEmails: config.articleAuthorityServiceAccountEmails,
    }, overrides.verifier);
  } catch {
    return { ok: false, response: articleAuthorityJson({ error: "unavailable" }, 503) };
  }
  if (!identity.ok) {
    return { ok: false, response: articleAuthorityJson({ error: identity.kind === "outage" ? "unavailable" : "invalid_identity" }, identity.kind === "outage" ? 503 : 401) };
  }
  const repository = (overrides.repository ?? articleAuthorityRepository)();
  return repository
    ? { ok: true, dependencies: { repository, checkNiho: checkNihoArticleAuthority } }
    : { ok: false, response: articleAuthorityJson({ error: "unavailable" }, 503) };
}

export async function readArticleAuthorityBody(request: Request): Promise<Record<string, unknown>> {
  if (new URL(request.url).search) throw new StoreValidationError("Query strings are not allowed.");
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    throw new StoreValidationError("Content-Type must be application/json.");
  }
  let body: unknown;
  try { body = await readBoundedJson(request, BODY_LIMIT, { fatalUtf8: true }); }
  catch (error) { throw new StoreValidationError("Request body is invalid.", { cause: error }); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new StoreValidationError("Request body must be an object.");
  return body as Record<string, unknown>;
}

export function exactFields(body: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !(key in body)) || Object.keys(body).some((key) => !allowed.has(key))) {
    throw new StoreValidationError("Request body fields do not match the contract.");
  }
}

export function providerId(value: unknown): string {
  if (typeof value !== "string" || !PROVIDER_ID.test(value)) throw new StoreValidationError("providerId is invalid.");
  return value;
}

export function writerId(value: unknown): string {
  if (typeof value !== "string" || !USER_ID.test(value)) throw new StoreValidationError("writerNihoUserId is invalid.");
  return value;
}

async function serviceToken(audience: string): Promise<string> {
  const client = await googleAuth.getIdTokenClient(audience);
  const headers = await client.getRequestHeaders();
  const authorization = headers.authorization ?? headers.Authorization;
  if (typeof authorization !== "string" || !/^Bearer [^\s]+$/.test(authorization)) throw new Error("Service identity unavailable");
  return authorization.slice(7);
}

function parseNihoAuthority(value: unknown, requested: ReadonlySet<string>): NihoArticleAuthorityResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid authority response");
  const body = value as Record<string, unknown>;
  if (Object.keys(body).sort().join(",") !== "links,version,writer" || body.version !== 1 || typeof body.writer !== "boolean" || !Array.isArray(body.links)) throw new Error("Invalid authority response");
  const seen = new Set<string>();
  const links = body.links.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid authority response");
    const link = item as Record<string, unknown>;
    if (Object.keys(link).sort().join(",") !== "inviterNihoUserId,providerId" || typeof link.providerId !== "string" || !PROVIDER_ID.test(link.providerId) || !requested.has(link.providerId) || seen.has(link.providerId) || typeof link.inviterNihoUserId !== "string" || !USER_ID.test(link.inviterNihoUserId)) throw new Error("Invalid authority response");
    seen.add(link.providerId);
    return { providerId: link.providerId, inviterNihoUserId: link.inviterNihoUserId };
  });
  return { version: 1, writer: body.writer, links };
}

export async function checkNihoArticleAuthority(writerNihoUserId: string, providerIds: readonly string[]): Promise<NihoArticleAuthorityResult> {
  writerId(writerNihoUserId);
  if (providerIds.length > 32 || new Set(providerIds).size !== providerIds.length) throw new StoreValidationError("providerIds is invalid.");
  providerIds.forEach(providerId);
  const token = await serviceToken(config.nihoArticleAuthorityAudience);
  const response = await fetch(new URL("/api/internal/editor-article-authority/check", config.nihoArticleAuthorityOrigin), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ writerNihoUserId, providerIds }),
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
    signal: AbortSignal.timeout(8_000),
  });
  if (response.status !== 200 || response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("NIHO authority unavailable");
  }
  return parseNihoAuthority(await readBoundedJson(response, RESPONSE_LIMIT, { fatalUtf8: true }), new Set(providerIds));
}

export function articleAuthorityFailure(error: unknown): Response {
  return error instanceof StoreValidationError
    ? articleAuthorityJson({ error: "invalid_input" }, 400)
    : articleAuthorityJson({ error: "unavailable" }, 503);
}
