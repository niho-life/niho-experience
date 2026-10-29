import { privateGuideArticle } from "@/lib/editor/guide-api";
import { guideApiError, guideApiJson, loadGuideApiContext } from "@/lib/editor/guide-api-server";
import { guidePublicationProblems } from "@/lib/editor/guide-publication";

type GuideRouteContext = { params: Promise<{ articleId: string }> };

export async function GET(_request: Request, context: GuideRouteContext) {
  const loaded = await loadGuideApiContext();
  if (!loaded.ok) return loaded.response;
  const { articleId } = await context.params;
  try {
    const article = await loaded.value.repository.getArticle(loaded.value.actor, articleId);
    const categories = await loaded.value.repository.listActiveCategories();
    const problems = guidePublicationProblems(article, new Set(categories.map((category) => category.slug)));
    return guideApiJson({ guide: privateGuideArticle(article), problems });
  } catch (error) {
    return guideApiError(error);
  }
}
