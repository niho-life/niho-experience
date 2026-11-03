import "server-only";
import { StoreValidationError, type ArticleAuthorityCandidate, type ArticleAuthorityRepository } from "@niho-experience/experience-store";
import { GoogleAuth } from "google-auth-library";
import { config } from "@/lib/config";
import { articleAuthorityRepository } from "@/lib/experience/store-server";
import { verifyGoogleServiceIdentity, type GoogleServiceTokenVerifier } from "@/lib/google-service-identity";
import { readBoundedJson } from "@/lib/read-bounded-json";

const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const USER_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const BODY_LIMIT = 4 * 1024;
const RESPONSE_LIMIT = 64 * 1024;
const PAGE_SIZE = 20;
const SCAN_SIZE = 96;
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

export function articleSlugs(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 32 || new Set(value).size !== value.length || value.some((slug) => typeof slug !== "string" || slug.length > 160 || !SLUG.test(slug))) {
    throw new StoreValidationError("slugs is invalid.");
  }
  return value as string[];
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

async function allowedProviders(writerNihoUserId: string, providerIds: readonly string[], deps: ArticleAuthorityDependencies): Promise<Set<string> | null> {
  const unique = [...new Set(providerIds)];
  const owned = new Set(await deps.repository.ownedProviderIds(writerNihoUserId));
  const allowed = new Set(unique.filter((id) => owned.has(id)));
  let writer = true;
  for (let offset = 0; offset < unique.length || offset === 0; offset += 32) {
    const chunk = unique.slice(offset, offset + 32);
    const authority = await deps.checkNiho(writerNihoUserId, chunk);
    writer &&= authority.writer;
    if (!authority.writer) continue;
    const owners = await deps.repository.activeOwnerIds(chunk);
    for (const link of authority.links) {
      if (owners.get(link.providerId)?.has(link.inviterNihoUserId)) allowed.add(link.providerId);
    }
    if (!unique.length) break;
  }
  return writer ? allowed : null;
}

export async function candidateItems(input: Readonly<{ writerNihoUserId: string; query?: string; cursor?: string }>, deps: ArticleAuthorityDependencies) {
  const scanned = await deps.repository.listPublishedCandidates({ query: input.query, afterSlug: input.cursor, limit: SCAN_SIZE });
  const allowed = await allowedProviders(input.writerNihoUserId, scanned.map((item) => item.providerId), deps);
  if (!allowed) return { version: 1 as const, items: [], nextCursor: null };
  const items: { slug: string; title: string; providerName: string }[] = [];
  const ambiguous = new Set<string>();
  const counts = new Map<string, number>();
  for (const item of scanned) counts.set(item.slug, (counts.get(item.slug) ?? 0) + 1);
  for (const [slug, count] of counts) if (count > 1) ambiguous.add(slug);
  let consumed = 0;
  for (const item of scanned) {
    consumed += 1;
    if (allowed.has(item.providerId) && !ambiguous.has(item.slug)) items.push({ slug: item.slug, title: item.title, providerName: item.providerName });
    if (items.length >= PAGE_SIZE) break;
  }
  const hasMore = consumed < scanned.length || scanned.length === SCAN_SIZE;
  const cursor = hasMore ? scanned[consumed - 1]?.slug ?? null : null;
  return { version: 1 as const, items, nextCursor: cursor };
}

export async function allowedRelatedSlugs(writerNihoUserId: string, slugs: readonly string[], deps: ArticleAuthorityDependencies): Promise<readonly string[]> {
  const products = await deps.repository.publishedProductsBySlugs(slugs);
  const counts = new Map<string, number>();
  for (const item of products) counts.set(item.slug, (counts.get(item.slug) ?? 0) + 1);
  const allowed = await allowedProviders(writerNihoUserId, products.map((item) => item.providerId), deps);
  if (!allowed) return [];
  const bySlug = new Map<string, ArticleAuthorityCandidate>();
  for (const item of products) if (counts.get(item.slug) === 1) bySlug.set(item.slug, item);
  return slugs.filter((slug) => {
    const item = bySlug.get(slug);
    return item !== undefined && allowed.has(item.providerId);
  });
}

export function articleAuthorityFailure(error: unknown): Response {
  return error instanceof StoreValidationError
    ? articleAuthorityJson({ error: "invalid_input" }, 400)
    : articleAuthorityJson({ error: "unavailable" }, 503);
}
