import { decodeExperienceProviderPageMeetingPointUpdateRequest } from "@niho-experience/api-client/host-schema";
import { isExperienceProviderOperationPathId } from "@niho-experience/api-client/experience-provider-operations-schema";
import { isPageVersion, loadProviderPagesClient, providerPagesFailure } from "@/lib/host/provider-pages-server";
import { providerOperationsJson, providerOperationsMutationAllowed, readProviderOperationsJson } from "@/lib/host/provider-operations-server";

type Context = { params: Promise<{ providerId: string; pageId: string }> };
async function ids(context: Context) { const value = await context.params; return isExperienceProviderOperationPathId(value.providerId) && isExperienceProviderOperationPathId(value.pageId) ? value : null; }
export async function GET(request: Request, context: Context) {
  const value = await ids(context); if (!value || new URL(request.url).search) return providerOperationsJson({ error: "not_found" }, 404);
  const loaded = await loadProviderPagesClient(); if (!loaded.ok) return loaded.response;
  const result = await loaded.client.getExperienceProviderPageMeetingPoint(value.providerId, value.pageId);
  return result.ok ? providerOperationsJson(result.data) : providerPagesFailure(result);
}
/** INHERIT (the provider's default) or OVERRIDE with all five fields; the version is the page's `updatedAt`, and the answer carries the page's new one. */
export async function PUT(request: Request, context: Context) {
  const value = await ids(context); if (!value || new URL(request.url).search) return providerOperationsJson({ error: "not_found" }, 404);
  if (!providerOperationsMutationAllowed(request)) return providerOperationsJson({ error: "forbidden" }, 403);
  const body = await readProviderOperationsJson(request, 64 * 1024);
  const input = body.ok ? decodeExperienceProviderPageMeetingPointUpdateRequest(body.value) : null;
  if (!input || !isPageVersion(input.expectedUpdatedAt)) return providerOperationsJson({ error: "invalid_input" }, 400);
  const loaded = await loadProviderPagesClient(); if (!loaded.ok) return loaded.response;
  const result = await loaded.client.updateExperienceProviderPageMeetingPoint(value.providerId, value.pageId, input);
  return result.ok ? providerOperationsJson(result.data) : providerPagesFailure(result);
}
