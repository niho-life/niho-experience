import { decodeExperienceProviderPageListingRequest } from "@niho-experience/api-client/host-schema";
import { isExperienceProviderOperationPathId } from "@niho-experience/api-client/experience-provider-operations-schema";
import { loadProviderPagesClient, providerPagesFailure } from "@/lib/host/provider-pages-server";
import { providerOperationsJson, providerOperationsMutationAllowed, readProviderOperationsJson } from "@/lib/host/provider-operations-server";

/* 体験サイトへの掲載 (OWNER; NIHO answers 404 to anyone else): its state and consent, the request with the consent version, and the withdrawal. */
type Context = { params: Promise<{ providerId: string; pageId: string }> };
async function ids(context: Context) { const value = await context.params; return isExperienceProviderOperationPathId(value.providerId) && isExperienceProviderOperationPathId(value.pageId) ? value : null; }
export async function GET(request: Request, context: Context) {
  const value = await ids(context); if (!value || new URL(request.url).search) return providerOperationsJson({ error: "not_found" }, 404);
  const loaded = await loadProviderPagesClient(); if (!loaded.ok) return loaded.response;
  const result = await loaded.client.getExperienceProviderPageListing(value.providerId, value.pageId);
  return result.ok ? providerOperationsJson(result.data) : providerPagesFailure(result);
}
export async function PUT(request: Request, context: Context) {
  const value = await ids(context); if (!value || new URL(request.url).search) return providerOperationsJson({ error: "not_found" }, 404);
  if (!providerOperationsMutationAllowed(request)) return providerOperationsJson({ error: "forbidden" }, 403);
  const body = await readProviderOperationsJson(request, 1024);
  const input = body.ok ? decodeExperienceProviderPageListingRequest(body.value) : null;
  if (!input) return providerOperationsJson({ error: "invalid_input" }, 400);
  const loaded = await loadProviderPagesClient(); if (!loaded.ok) return loaded.response;
  const result = await loaded.client.requestExperienceProviderPageListing(value.providerId, value.pageId, input);
  return result.ok ? providerOperationsJson(result.data) : providerPagesFailure(result);
}
export async function DELETE(request: Request, context: Context) {
  const value = await ids(context); if (!value || new URL(request.url).search) return providerOperationsJson({ error: "not_found" }, 404);
  if (!providerOperationsMutationAllowed(request)) return providerOperationsJson({ error: "forbidden" }, 403);
  if ((await request.text().catch(() => "invalid")) !== "") return providerOperationsJson({ error: "invalid_input" }, 400);
  const loaded = await loadProviderPagesClient(); if (!loaded.ok) return loaded.response;
  const result = await loaded.client.withdrawExperienceProviderPageListing(value.providerId, value.pageId);
  return result.ok ? providerOperationsJson(result.data) : providerPagesFailure(result);
}
