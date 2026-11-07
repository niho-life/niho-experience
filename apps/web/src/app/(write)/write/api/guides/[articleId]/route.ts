import {
  loadWriteContext,
  parseWritePatch,
  privateGuideArticle,
  readWriteJson,
  validArticleId,
  writeApiError,
  writeJson,
  writeMutationAllowed,
} from "@/lib/write/server";

type Context = { readonly params: Promise<{ readonly articleId: string }> };
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: Context) {
  if (new URL(request.url).search) return writeJson({ error: "invalid_input" }, 400);
  const { articleId } = await context.params;
  if (!validArticleId(articleId)) return writeJson({ error: "not_found" }, 404);
  const loaded = await loadWriteContext();
  if (!loaded.ok) return loaded.response;
  try {
    return writeJson({ guide: privateGuideArticle(await loaded.value.repository.getArticle(loaded.value.actorId, articleId)) });
  } catch (error) { return writeApiError(error); }
}

export async function PATCH(request: Request, context: Context) {
  if (!writeMutationAllowed(request)) return writeJson({ error: "cross_site_request" }, 403);
  if (new URL(request.url).search) return writeJson({ error: "invalid_input" }, 400);
  const { articleId } = await context.params;
  if (!validArticleId(articleId)) return writeJson({ error: "not_found" }, 404);
  const loaded = await loadWriteContext();
  if (!loaded.ok) return loaded.response;
  const raw = await readWriteJson(request);
  if (!raw.ok) return raw.response;
  const input = parseWritePatch(raw.value);
  if (!input) return writeJson({ error: "invalid_input" }, 400);
  try {
    const article = await loaded.value.repository.saveDraft(loaded.value.actorId, articleId, input.draft, input.expectedRevision);
    return writeJson({ guide: privateGuideArticle(article) });
  } catch (error) { return writeApiError(error); }
}
