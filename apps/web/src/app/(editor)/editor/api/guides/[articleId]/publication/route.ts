import { privateGuideArticle } from "@/lib/editor/guide-api";
import {
  guideApiError,
  guideApiJson,
  guideApiMutationAllowed,
  loadGuideApiContext,
  readGuideApiJson,
} from "@/lib/editor/guide-api-server";
import {
  guidePublicationProblems,
  parseGuidePublicationInput,
  parseGuideStopPublicationInput,
} from "@/lib/editor/guide-publication";

type GuideRouteContext = { params: Promise<{ articleId: string }> };

async function publicationRequest(request: Request) {
  if (!guideApiMutationAllowed(request)) return { ok: false as const, response: guideApiJson({ error: "cross_site_request" }, 403) };
  const raw = await readGuideApiJson(request);
  if (!raw.ok) return { ok: false as const, response: guideApiJson({ error: "invalid_input" }, 400) };
  return { ok: true as const, value: raw.value };
}

export async function POST(request: Request, context: GuideRouteContext) {
  const loaded = await loadGuideApiContext();
  if (!loaded.ok) return loaded.response;
  const raw = await publicationRequest(request);
  if (!raw.ok) return raw.response;
  const input = parseGuidePublicationInput(raw.value);
  if (!input) return guideApiJson({ error: "invalid_input" }, 400);
  const { articleId } = await context.params;

  try {
    const article = await loaded.value.repository.getArticle(loaded.value.actor, articleId);
    if (article.revision !== input.expectedRevision) return guideApiJson({ error: "conflict" }, 409);
    const categories = await loaded.value.repository.listActiveCategories();
    const problems = guidePublicationProblems(article, new Set(categories.map((category) => category.slug)));
    if (problems.length) return guideApiJson({ error: "invalid_input", problems }, 400);

    await loaded.value.repository.commitPublication(loaded.value.actor, articleId, {
      expectedRevision: input.expectedRevision,
      visibility: input.visibility,
      productLinks: [],
    });
    // Publication is committed. A second tab may save before this read, so never
    // give the caller a newer revision for content it has not displayed.
    try {
      const current = await loaded.value.repository.getArticle(loaded.value.actor, articleId);
      if (current.revision === input.expectedRevision + 1) {
        return guideApiJson({ guide: privateGuideArticle(current) });
      }
    } catch { /* The committed publication still needs an honest response. */ }
    return guideApiJson({ result: "committed_needs_refresh" });
  } catch (error) {
    return guideApiError(error);
  }
}

export async function DELETE(request: Request, context: GuideRouteContext) {
  const loaded = await loadGuideApiContext();
  if (!loaded.ok) return loaded.response;
  const raw = await publicationRequest(request);
  if (!raw.ok) return raw.response;
  const input = parseGuideStopPublicationInput(raw.value);
  if (!input) return guideApiJson({ error: "invalid_input" }, 400);
  const { articleId } = await context.params;

  try {
    const article = await loaded.value.repository.stopPublication(
      loaded.value.actor,
      articleId,
      input.expectedRevision,
    );
    return guideApiJson({ guide: privateGuideArticle(article) });
  } catch (error) {
    return guideApiError(error);
  }
}
