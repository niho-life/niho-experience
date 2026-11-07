import "server-only";
import { NextResponse } from "next/server";
import {
  StoreAccessDeniedError,
  StoreConflictError,
  StoreNotFoundError,
  StoreValidationError,
  type ExperiencePublicationRepository,
  type GuideArticleRecord,
  type GuideAuthor,
  type GuideContent,
  type GuideDraftCover,
  type GuideProductLinkInput,
  type GuideRepository,
  type SaveGuideDraftInput,
} from "@niho-experience/experience-store";
import { config } from "@/lib/config";
import { experiencePublicationRepository, guideRepository } from "@/lib/experience/store-server";
import { clearSessionCookie, loadHostProvidersFresh, siteOrigin } from "@/lib/host/server";
import { mutationFromSameOrigin } from "@/lib/host/relay";
import { readBoundedJson, ResponseBodyTooLarge } from "@/lib/read-bounded-json";

const WRITE_HEADERS = {
  "cache-control": "private, no-store, max-age=0",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-robots-tag": "noindex, nofollow, noarchive",
};
export const WRITE_JSON_MAX_BYTES = 600 * 1024;
const ARTICLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const GUIDE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type JsonObject = Record<string, unknown>;
type WriteGuideRepository = Pick<GuideRepository,
  "listActiveCategories" | "createArticle" | "listArticles" | "getArticle" | "saveDraft"
  | "commitPublication" | "stopPublication" | "createMediaAsset" | "markMediaAssetReady"
  | "getReadyMediaAsset" | "listReadyMediaAssets" | "confirmMediaAssetWebRights" | "revokeMediaAsset">;
type WriteProductRepository = Pick<ExperiencePublicationRepository, "listProducts">;

export type WriteContext = {
  readonly actorId: string;
  /** Safe client-facing identity projection. Private NIHO ids and email stay outside /write UI. */
  readonly ownerProviders: readonly { readonly id: string; readonly displayName: string }[];
  readonly ownerProviderIds: readonly string[];
  readonly repository: WriteGuideRepository;
  readonly products: WriteProductRepository;
};

export function writeJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: WRITE_HEADERS });
}

export function writeImage(bytes: Buffer): Response {
  return new Response(Uint8Array.from(bytes).buffer, {
    headers: { ...WRITE_HEADERS, "content-type": "image/jpeg", "content-length": String(bytes.byteLength) },
  });
}

export function writeMutationAllowed(request: Request): boolean {
  return mutationFromSameOrigin(request.method, request.headers, siteOrigin());
}

export function validArticleId(value: unknown): value is string {
  return typeof value === "string" && ARTICLE_ID.test(value);
}

export function experienceSlugFromUrl(request: Request): string | null | false {
  const search = new URL(request.url).searchParams;
  const keys = [...search.keys()];
  if (keys.some((key) => key !== "experience")) return false;
  const values = search.getAll("experience");
  if (values.length === 0) return null;
  if (values.length !== 1 || values[0]!.length > 160 || !GUIDE_SLUG.test(values[0]!)) return false;
  return values[0]!;
}

/** Fresh identity plus the current local OWNER projection. Store methods check it again transactionally. */
export async function loadWriteContext(providerId?: string): Promise<
  | { readonly ok: true; readonly value: WriteContext }
  | { readonly ok: false; readonly response: NextResponse }
> {
  // Until the public reader uses this same database, accepting a publication
  // would report success for an article travelers cannot see.
  if (config.apiMode === "http" && config.guidePublicSource !== "database") {
    return { ok: false, response: writeJson({ error: "write_not_ready" }, 503) };
  }
  const providers = await loadHostProvidersFresh();
  if (providers.status === "signed-out") return { ok: false, response: writeJson({ error: "unauthenticated" }, 401) };
  if (providers.status === "refresh") return { ok: false, response: writeJson({ error: "session_refresh_required" }, 401) };
  if (providers.status === "rejected") {
    const response = writeJson({ error: "session_ended" }, 401);
    clearSessionCookie(response);
    return { ok: false, response };
  }
  if (providers.status === "error") return { ok: false, response: writeJson({ error: "unavailable" }, 503) };
  const owners = providers.providers.filter((provider) => provider.memberRole === "OWNER");
  if (owners.length === 0 || (providerId !== undefined && !owners.some((provider) => provider.id === providerId))) {
    return { ok: false, response: writeJson({ error: "forbidden" }, 403) };
  }
  const repository = guideRepository();
  const products = experiencePublicationRepository();
  if (!repository || !products) return { ok: false, response: writeJson({ error: "unavailable" }, 503) };
  return {
    ok: true,
    value: {
      actorId: providers.nihoUserId,
      ownerProviders: owners.map((provider) => ({ id: provider.id, displayName: provider.displayName })),
      ownerProviderIds: owners.map((provider) => provider.id),
      repository,
      products,
    },
  };
}

export function writeApiError(error: unknown): NextResponse {
  if (error instanceof StoreValidationError) return writeJson({ error: "invalid_input" }, 400);
  if (error instanceof StoreConflictError) return writeJson({ error: "conflict" }, 409);
  // An article outside this actor's current OWNER scope is indistinguishable
  // from a missing one. Provider selection is rejected earlier with 403.
  if (error instanceof StoreAccessDeniedError || error instanceof StoreNotFoundError) return writeJson({ error: "not_found" }, 404);
  return writeJson({ error: "unavailable" }, 503);
}

export async function readWriteJson(request: Request): Promise<
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly response: NextResponse }
> {
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") return { ok: false, response: writeJson({ error: "unsupported_media_type" }, 415) };
  try {
    return { ok: true, value: await readBoundedJson(request, WRITE_JSON_MAX_BYTES, { fatalUtf8: true }) };
  } catch (error) {
    return { ok: false, response: writeJson({ error: error instanceof ResponseBodyTooLarge ? "payload_too_large" : "invalid_input" }, error instanceof ResponseBodyTooLarge ? 413 : 400) };
  }
}

function objectWithOnly(value: unknown, allowed: readonly string[]): JsonObject | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const object = value as JsonObject;
  return Object.keys(object).every((key) => allowed.includes(key)) ? object : null;
}

function exactObject(value: unknown, keys: readonly string[]): JsonObject | null {
  const object = objectWithOnly(value, keys);
  return object && Object.keys(object).length === keys.length ? object : null;
}

function parseAuthor(value: unknown): GuideAuthor | null {
  const author = exactObject(value, ["name", "role", "bio"]);
  return author && typeof author.name === "string" && typeof author.role === "string" && typeof author.bio === "string"
    ? { name: author.name, role: author.role, bio: author.bio }
    : null;
}

function parseContent(value: unknown): GuideContent | null {
  const content = objectWithOnly(value, ["markdown", "language", "author", "checkedOn"]);
  if (!content || typeof content.markdown !== "string" || (content.language !== undefined && content.language !== "en")) return null;
  let author: GuideAuthor | undefined;
  if (content.author !== undefined) {
    const parsed = parseAuthor(content.author);
    if (!parsed) return null;
    author = parsed;
  }
  if (content.checkedOn !== undefined && typeof content.checkedOn !== "string") return null;
  return {
    markdown: content.markdown,
    ...(content.language === undefined ? {} : { language: "en" as const }),
    ...(author === undefined ? {} : { author }),
    ...(content.checkedOn === undefined ? {} : { checkedOn: content.checkedOn as string }),
  };
}

function parseCover(value: unknown): GuideDraftCover | null {
  const cover = exactObject(value, ["assetId", "alt", "credit", "webConfirmed"]);
  return cover && typeof cover.assetId === "string" && typeof cover.alt === "string"
    && typeof cover.credit === "string" && typeof cover.webConfirmed === "boolean"
    ? { assetId: cover.assetId, alt: cover.alt, credit: cover.credit, webConfirmed: cover.webConfirmed }
    : null;
}

function parseLinks(value: unknown): readonly GuideProductLinkInput[] | null {
  if (!Array.isArray(value) || value.length > 3) return null;
  const result: GuideProductLinkInput[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    const link = exactObject(candidate, ["providerId", "productId"]);
    if (!link || typeof link.providerId !== "string" || typeof link.productId !== "string") return null;
    const key = `${link.providerId}\u0000${link.productId}`;
    if (seen.has(key)) return null;
    seen.add(key);
    result.push({ providerId: link.providerId, productId: link.productId });
  }
  return result;
}

export type WriteCreateInput = {
  readonly id: string;
  readonly providerId: string;
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly categorySlug?: string;
  readonly content: GuideContent;
};

export function parseWriteCreate(value: unknown): WriteCreateInput | null {
  const body = objectWithOnly(value, ["id", "providerId", "slug", "title", "description", "categorySlug", "content"]);
  if (!body || !UUID_V4.test(typeof body.id === "string" ? body.id : "") || typeof body.providerId !== "string"
    || typeof body.slug !== "string" || typeof body.title !== "string"
    || (body.description !== undefined && typeof body.description !== "string")
    || (body.categorySlug !== undefined && typeof body.categorySlug !== "string")) return null;
  const content = body.content === undefined ? { markdown: "", language: "en" as const } : parseContent(body.content);
  if (!content) return null;
  return {
    id: body.id as string,
    providerId: body.providerId,
    slug: body.slug,
    title: body.title,
    description: (body.description as string | undefined) ?? "",
    ...(body.categorySlug === undefined ? {} : { categorySlug: body.categorySlug as string }),
    content,
  };
}

export type WritePatchInput = { readonly draft: SaveGuideDraftInput; readonly expectedRevision: number };

export function parseWritePatch(value: unknown): WritePatchInput | null {
  const body = objectWithOnly(value, ["slug", "title", "description", "categorySlug", "content", "cover", "draftProductLinks", "expectedRevision"]);
  if (!body || typeof body.slug !== "string" || typeof body.title !== "string" || typeof body.description !== "string"
    || (body.categorySlug !== undefined && typeof body.categorySlug !== "string")
    || !Number.isSafeInteger(body.expectedRevision) || (body.expectedRevision as number) < 1) return null;
  const content = parseContent(body.content);
  if (!content) return null;
  let cover: GuideDraftCover | null | undefined;
  if (body.cover === null) cover = null;
  else if (body.cover !== undefined) {
    cover = parseCover(body.cover);
    if (!cover) return null;
  }
  let links: readonly GuideProductLinkInput[] | undefined;
  if (body.draftProductLinks !== undefined) {
    const parsed = parseLinks(body.draftProductLinks);
    if (!parsed) return null;
    links = parsed;
  }
  return {
    expectedRevision: body.expectedRevision as number,
    draft: {
      slug: body.slug,
      title: body.title,
      description: body.description,
      ...(body.categorySlug === undefined ? {} : { categorySlug: body.categorySlug as string }),
      content,
      ...(cover === undefined ? {} : { cover }),
      ...(links === undefined ? {} : { draftProductLinks: links }),
    },
  };
}

export function privateGuideArticle(article: GuideArticleRecord) {
  return {
    id: article.id,
    slug: article.slug,
    subject: article.subject,
    title: article.title,
    description: article.description,
    ...(article.categorySlug === undefined ? {} : { categorySlug: article.categorySlug }),
    content: article.content,
    ...(article.cover === undefined ? {} : { cover: article.cover }),
    draftProductLinks: article.draftProductLinks,
    status: article.status,
    ...(article.opsStopReason === undefined ? {} : { opsStopReason: article.opsStopReason }),
    ...(article.opsStopContact === undefined ? {} : { opsStopContact: article.opsStopContact }),
    revision: article.revision,
    ...(article.currentPublication === undefined ? {} : { currentPublication: article.currentPublication }),
    createdAtUtc: article.createdAtUtc,
    updatedAtUtc: article.updatedAtUtc,
  };
}

function createFieldsMatch(article: GuideArticleRecord, input: WriteCreateInput): boolean {
  return article.id === input.id && article.slug === input.slug && article.subject.kind === "PROVIDER"
    && article.subject.providerId === input.providerId && article.title === input.title
    && article.description === input.description && article.categorySlug === input.categorySlug
    && JSON.stringify(article.content) === JSON.stringify(input.content);
}

/**
 * The client-generated article UUID is the idempotency key. A retry may finish
 * the optional experience link after a crash between create and save, but it
 * never adopts a different provider, slug, or body under the same UUID.
 */
export async function createGuideIdempotently(
  context: WriteContext,
  input: WriteCreateInput,
  experienceSlug: string | null,
): Promise<{ readonly article: GuideArticleRecord; readonly created: boolean; readonly experienceLinked: boolean }> {
  let link: GuideProductLinkInput | null = null;
  if (experienceSlug) {
    const products = await context.products.listProducts({ providerId: input.providerId, nihoUserId: context.actorId });
    const product = products.find((candidate) => candidate.slug === experienceSlug && candidate.status === "PUBLISHED");
    if (product) link = { providerId: input.providerId, productId: product.id };
  }

  let article: GuideArticleRecord;
  let created = false;
  try {
    article = await context.repository.createArticle(context.actorId, {
      id: input.id,
      slug: input.slug,
      subject: { kind: "PROVIDER", providerId: input.providerId },
      title: input.title,
      description: input.description,
      ...(input.categorySlug === undefined ? {} : { categorySlug: input.categorySlug }),
      content: input.content,
    });
    created = true;
  } catch (error) {
    if (!(error instanceof StoreConflictError)) throw error;
    try { article = await context.repository.getArticle(context.actorId, input.id); }
    catch { throw error; }
    if (!createFieldsMatch(article, input)) throw error;
  }

  if (link) {
    const sameLink = (value: GuideArticleRecord) => value.draftProductLinks.length === 1
      && value.draftProductLinks[0]!.providerId === link.providerId
      && value.draftProductLinks[0]!.productId === link.productId;
    if (!sameLink(article)) {
      if (article.revision !== 1 || article.draftProductLinks.length !== 0) throw new StoreConflictError("The idempotent create result changed before its experience link was saved.");
      try {
        article = await context.repository.saveDraft(context.actorId, article.id, {
          slug: article.slug,
          title: article.title,
          description: article.description,
          ...(article.categorySlug === undefined ? {} : { categorySlug: article.categorySlug }),
          content: article.content,
          ...(article.cover === undefined ? {} : { cover: article.cover }),
          draftProductLinks: [link],
        }, article.revision);
      } catch (error) {
        if (!(error instanceof StoreConflictError)) throw error;
        const current = await context.repository.getArticle(context.actorId, article.id);
        if (!createFieldsMatch(current, input) || !sameLink(current)) throw error;
        article = current;
      }
    }
  }
  return { article, created, experienceLinked: link !== null };
}

export function guidePublicUrl(slug: string): string {
  return new URL(`/guides/${encodeURIComponent(slug)}`, config.siteUrl).toString();
}
