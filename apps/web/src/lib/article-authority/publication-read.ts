import "server-only";
import { GoogleAuth } from "google-auth-library";
import type { Guide } from "@/content/guides";
import { config } from "@/lib/config";
import { articleAuthorityRepository } from "@/lib/experience/store-server";
import { readBoundedJson } from "@/lib/read-bounded-json";
import { allowedRelatedSlugs, checkNihoArticleAuthority } from "./server";

const USER_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const auth = new GoogleAuth();

async function editorPublicationAuthority(publicationId: string, version: number): Promise<{ writerNihoUserId: string; slugs: readonly string[] }> {
  const client = await auth.getIdTokenClient(config.editorArticleAuthorityAudience);
  const headers = await client.getRequestHeaders();
  const authorization = headers.authorization ?? headers.Authorization;
  if (typeof authorization !== "string" || !/^Bearer [^\s]+$/.test(authorization)) throw new Error("Editor identity unavailable");
  const response = await fetch(new URL("/internal/article-authority/v1/publication", config.editorArticleAuthorityOrigin), {
    method: "POST", headers: { authorization, accept: "application/json", "content-type": "application/json" }, body: JSON.stringify({ publicationId, version }),
    cache: "no-store", credentials: "omit", redirect: "error", signal: AbortSignal.timeout(8_000),
  });
  if (response.status !== 200 || response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Editor authority unavailable");
  }
  const value = await readBoundedJson(response, 16 * 1024, { fatalUtf8: true });
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Editor authority response");
  const body = value as Record<string, unknown>;
  if (Object.keys(body).sort().join(",") !== "slugs,version,writerNihoUserId" || body.version !== 1 || typeof body.writerNihoUserId !== "string" || !USER_ID.test(body.writerNihoUserId)
    || !Array.isArray(body.slugs) || body.slugs.length > 20 || new Set(body.slugs).size !== body.slugs.length || body.slugs.some((slug) => typeof slug !== "string" || !SLUG.test(slug))) throw new Error("Invalid Editor authority response");
  return { writerNihoUserId: body.writerNihoUserId, slugs: body.slugs as string[] };
}

export interface PublicationReadDependencies {
  readonly authority: (publicationId: string, version: number) => Promise<{ writerNihoUserId: string; slugs: readonly string[] }>;
  readonly repository: typeof articleAuthorityRepository;
  readonly checkNiho: typeof checkNihoArticleAuthority;
}

/** Re-checks all three authorities per request. Failure removes only related links, never the article body. */
export async function filterCurrentRelatedGuide(
  guide: Guide,
  dependencies: PublicationReadDependencies = {
    authority: editorPublicationAuthority,
    repository: articleAuthorityRepository,
    checkNiho: checkNihoArticleAuthority,
  },
): Promise<Guide> {
  if (!guide.editorPublication) return guide;
  if (!config.articleAuthorityApiEnabled) return { ...guide, relatedExperienceSlugs: [] };
  try {
    const authority = await dependencies.authority(guide.editorPublication.id, guide.editorPublication.version);
    const repository = dependencies.repository();
    if (!repository) throw new Error("Store unavailable");
    const allowed = await allowedRelatedSlugs(authority.writerNihoUserId, authority.slugs, { repository, checkNiho: dependencies.checkNiho });
    return { ...guide, relatedExperienceSlugs: allowed };
  } catch {
    return { ...guide, relatedExperienceSlugs: [] };
  }
}
