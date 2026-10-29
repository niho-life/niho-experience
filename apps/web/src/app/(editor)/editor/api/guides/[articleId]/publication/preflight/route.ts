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
    const media = await loaded.value.repository.listReadyMediaAssets(loaded.value.actor, articleId);
    const products = await loaded.value.repository.listLinkableProducts(loaded.value.actor, article.subject);
    const productKeys = new Set(products.map((product) => `${product.providerId}\u0000${product.productId}`));
    const problems = guidePublicationProblems(article, new Set(categories.map((category) => category.slug)), media, productKeys);
    return guideApiJson({ guide: privateGuideArticle(article), problems });
  } catch (error) {
    return guideApiError(error);
  }
}
