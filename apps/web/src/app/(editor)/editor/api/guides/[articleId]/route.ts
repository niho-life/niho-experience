import {
  guideApiError,
  guideApiJson,
  guideApiMutationAllowed,
  loadGuideApiContext,
  readGuideApiJson,
} from "@/lib/editor/guide-api-server";
import { parseGuidePatchBody, privateGuideArticle } from "@/lib/editor/guide-api";

type GuideRouteContext = { params: Promise<{ articleId: string }> };

export async function GET(_request: Request, context: GuideRouteContext) {
  const loaded = await loadGuideApiContext();
  if (!loaded.ok) return loaded.response;
  const { articleId } = await context.params;
  try {
    return guideApiJson({ guide: privateGuideArticle(await loaded.value.repository.getArticle(loaded.value.actor, articleId)) });
  } catch (error) {
    return guideApiError(error);
  }
}

export async function PATCH(request: Request, context: GuideRouteContext) {
  const loaded = await loadGuideApiContext();
  if (!loaded.ok) return loaded.response;
  if (!guideApiMutationAllowed(request)) return guideApiJson({ error: "cross_site_request" }, 403);
  const raw = await readGuideApiJson(request);
  if (!raw.ok) return guideApiJson({ error: "invalid_input" }, 400);
  const input = parseGuidePatchBody(raw.value);
  if (!input) return guideApiJson({ error: "invalid_input" }, 400);
  const { articleId } = await context.params;
  try {
    const article = await loaded.value.repository.saveDraft(
      loaded.value.actor,
      articleId,
      input.draft,
      input.expectedRevision,
    );
    return guideApiJson({ id: article.id, revision: article.revision });
  } catch (error) {
    return guideApiError(error);
  }
}
