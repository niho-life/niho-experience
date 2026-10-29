import { guideApiError, guideApiJson, loadGuideApiContext } from "@/lib/editor/guide-api-server";

type GuideRouteContext = { params: Promise<{ articleId: string }> };

export async function GET(_request: Request, context: GuideRouteContext) {
  const loaded = await loadGuideApiContext();
  if (!loaded.ok) return loaded.response;
  const { articleId } = await context.params;
  try {
    // Resolve the owned article first so callers cannot use a supplied provider ID
    // to enumerate another provider's catalogue.
    const article = await loaded.value.repository.getArticle(loaded.value.actor, articleId);
    const products = await loaded.value.repository.listLinkableProducts(loaded.value.actor, article.subject);
    return guideApiJson({ products });
  } catch (error) {
    return guideApiError(error);
  }
}
