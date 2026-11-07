import {
  guidePublicUrl,
  loadWriteContext,
  privateGuideArticle,
  readWriteJson,
  validArticleId,
  writeApiError,
  writeJson,
  writeMutationAllowed,
} from "@/lib/write/server";

type Context = { readonly params: Promise<{ readonly articleId: string }> };
export const dynamic = "force-dynamic";

function positiveRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

async function input(request: Request, keys: readonly string[]) {
  if (!writeMutationAllowed(request)) return { ok: false as const, response: writeJson({ error: "cross_site_request" }, 403) };
  if (new URL(request.url).search) return { ok: false as const, response: writeJson({ error: "invalid_input" }, 400) };
  const raw = await readWriteJson(request);
  if (!raw.ok) return raw;
  if (typeof raw.value !== "object" || raw.value === null || Array.isArray(raw.value)) return { ok: false as const, response: writeJson({ error: "invalid_input" }, 400) };
  const object = raw.value as Record<string, unknown>;
  if (Object.keys(object).length !== keys.length || Object.keys(object).some((key) => !keys.includes(key))) {
    return { ok: false as const, response: writeJson({ error: "invalid_input" }, 400) };
  }
  return { ok: true as const, value: object };
}

export async function POST(request: Request, context: Context) {
  const parsed = await input(request, ["expectedRevision", "visibility"]);
  if (!parsed.ok) return parsed.response;
  if (!positiveRevision(parsed.value.expectedRevision) || (parsed.value.visibility !== "PUBLIC" && parsed.value.visibility !== "UNLISTED")) {
    return writeJson({ error: "invalid_input" }, 400);
  }
  const { articleId } = await context.params;
  if (!validArticleId(articleId)) return writeJson({ error: "not_found" }, 404);
  const loaded = await loadWriteContext();
  if (!loaded.ok) return loaded.response;
  try {
    const publication = await loaded.value.repository.commitPublication(loaded.value.actorId, articleId, {
      expectedRevision: parsed.value.expectedRevision,
      visibility: parsed.value.visibility,
    });
    const article = await loaded.value.repository.getArticle(loaded.value.actorId, articleId);
    return writeJson({
      guide: privateGuideArticle(article),
      publication: { status: article.status, visibility: publication.visibility, url: guidePublicUrl(publication.slug) },
    });
  } catch (error) { return writeApiError(error); }
}

export async function DELETE(request: Request, context: Context) {
  const parsed = await input(request, ["expectedRevision"]);
  if (!parsed.ok) return parsed.response;
  if (!positiveRevision(parsed.value.expectedRevision)) return writeJson({ error: "invalid_input" }, 400);
  const { articleId } = await context.params;
  if (!validArticleId(articleId)) return writeJson({ error: "not_found" }, 404);
  const loaded = await loadWriteContext();
  if (!loaded.ok) return loaded.response;
  try {
    const article = await loaded.value.repository.stopPublication(loaded.value.actorId, articleId, parsed.value.expectedRevision);
    return writeJson({
      guide: privateGuideArticle(article),
      publication: { status: article.status, url: guidePublicUrl(article.slug) },
    });
  } catch (error) { return writeApiError(error); }
}
