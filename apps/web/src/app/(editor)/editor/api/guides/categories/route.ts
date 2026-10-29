import { guideApiError, guideApiJson, loadGuideApiContext } from "@/lib/editor/guide-api-server";

export async function GET() {
  const context = await loadGuideApiContext();
  if (!context.ok) return context.response;
  try {
    return guideApiJson({ categories: await context.value.repository.listActiveCategories() });
  } catch (error) {
    return guideApiError(error);
  }
}
