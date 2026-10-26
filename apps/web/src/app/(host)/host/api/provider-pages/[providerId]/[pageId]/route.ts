import { decodeExperienceProviderPagePatchRequest } from "@niho-experience/api-client/host-schema";
import { isExperienceProviderOperationPathId } from "@niho-experience/api-client/experience-provider-operations-schema";
import { isPageVersion, loadProviderPagesClient, providerPagesFailure } from "@/lib/host/provider-pages-server";
import { providerOperationsJson, providerOperationsMutationAllowed, readProviderOperationsJson } from "@/lib/host/provider-operations-server";

type Context = { params: Promise<{ providerId: string; pageId: string }> };
async function ids(context: Context) { const value = await context.params; return isExperienceProviderOperationPathId(value.providerId) && isExperienceProviderOperationPathId(value.pageId) ? value : null; }
export async function GET(request: Request, context: Context) {
  const value = await ids(context); if (!value || new URL(request.url).search) return providerOperationsJson({ error: "not_found" }, 404);
  const loaded = await loadProviderPagesClient(); if (!loaded.ok) return loaded.response;
  const result = await loaded.client.getExperienceProviderPage(value.providerId, value.pageId);
  return result.ok ? providerOperationsJson(result.data) : providerPagesFailure(result);
}
export async function PATCH(request: Request, context: Context) {
  const value = await ids(context); if (!value || new URL(request.url).search) return providerOperationsJson({ error: "not_found" }, 404);
  if (!providerOperationsMutationAllowed(request)) return providerOperationsJson({ error: "forbidden" }, 403);
  const body = await readProviderOperationsJson(request, 256 * 1024);
  if (!body.ok || typeof body.value !== "object" || body.value === null || Array.isArray(body.value) || Object.keys(body.value).length !== 2) return providerOperationsJson({ error: "invalid_input" }, 400);
  const raw = body.value as Record<string, unknown>; const patch = decodeExperienceProviderPagePatchRequest(raw.patch);
  if (!patch || !isPageVersion(raw.expectedUpdatedAt)) return providerOperationsJson({ error: "invalid_input" }, 400);
  const loaded = await loadProviderPagesClient(); if (!loaded.ok) return loaded.response;
  const result = await loaded.client.updateExperienceProviderPage(value.providerId, value.pageId, patch, raw.expectedUpdatedAt);
  return result.ok ? providerOperationsJson(result.data) : providerPagesFailure(result);
}
