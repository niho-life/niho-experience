import { guideAdminJson, guideAdminRouteFailure, loadGuideAdmin } from "@/lib/guide-admin/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const loaded = await loadGuideAdmin(request);
  if (!loaded.ok) return loaded.response;
  try {
    return guideAdminJson({ categories: await loaded.repository.listCategories() });
  } catch (error) {
    return guideAdminRouteFailure(error);
  }
}
