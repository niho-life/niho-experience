import { isExperienceProviderOperationPathId } from "@niho-experience/api-client/experience-provider-operations-schema";
import { isPageVersion, loadProviderPagesClient, providerPagesFailure } from "@/lib/host/provider-pages-server";
import { providerOperationsJson, providerOperationsMutationAllowed, readProviderOperationsJson } from "@/lib/host/provider-operations-server";

type Context = { params: Promise<{ providerId: string; pageId: string }> };
export async function POST(request: Request, context: Context) {
  const { providerId, pageId } = await context.params;
  if (new URL(request.url).search || !isExperienceProviderOperationPathId(providerId) || !isExperienceProviderOperationPathId(pageId)) return providerOperationsJson({ error: "not_found" }, 404);
  if (!providerOperationsMutationAllowed(request)) return providerOperationsJson({ error: "forbidden" }, 403);
  const body = await readProviderOperationsJson(request, 512);
  if (!body.ok || typeof body.value !== "object" || body.value === null || Array.isArray(body.value) || Object.keys(body.value).length !== 1 || !isPageVersion((body.value as Record<string, unknown>).expectedUpdatedAt)) return providerOperationsJson({ error: "invalid_input" }, 400);
  const loaded = await loadProviderPagesClient(); if (!loaded.ok) return loaded.response;
  const result = await loaded.client.publishExperienceProviderPage(providerId, pageId, (body.value as { expectedUpdatedAt: string }).expectedUpdatedAt);
  return result.ok ? providerOperationsJson(result.data) : providerPagesFailure(result);
}
