import { decodeExperienceProviderPutMemberInput, isExperienceProviderOperationPathId } from "@niho-experience/api-client/experience-provider-operations-schema";
import { loadProviderOperationsClient, providerOperationsEmpty, providerOperationsFailure, providerOperationsJson, providerOperationsMutationAllowed, readProviderOperationsJson } from "@/lib/host/provider-operations-server";

type Context = { params: Promise<{ providerId: string; userId: string }> };
async function ids(context: Context) { const value = await context.params; return isExperienceProviderOperationPathId(value.providerId) && isExperienceProviderOperationPathId(value.userId) ? value : null; }
export async function PUT(request: Request, context: Context) {
  const value = await ids(context);
  if (!value || new URL(request.url).search) return providerOperationsJson({ error: "not_found" }, 404);
  if (!providerOperationsMutationAllowed(request)) return providerOperationsJson({ error: "forbidden" }, 403);
  const body = await readProviderOperationsJson(request, 256);
  const input = body.ok ? decodeExperienceProviderPutMemberInput(body.value) : null;
  if (!input) return providerOperationsJson({ error: "invalid_input" }, 400);
  const loaded = await loadProviderOperationsClient(); if (!loaded.ok) return loaded.response;
  const result = await loaded.client.putCohost(value.providerId, value.userId, input);
  return result.ok ? providerOperationsJson(result.data) : providerOperationsFailure(result);
}
export async function DELETE(request: Request, context: Context) {
  const value = await ids(context);
  if (!value || new URL(request.url).search) return providerOperationsJson({ error: "not_found" }, 404);
  if (!providerOperationsMutationAllowed(request)) return providerOperationsJson({ error: "forbidden" }, 403);
  if ((await request.text().catch(() => "invalid")) !== "") return providerOperationsJson({ error: "invalid_input" }, 400);
  const loaded = await loadProviderOperationsClient(); if (!loaded.ok) return loaded.response;
  const result = await loaded.client.deleteCohost(value.providerId, value.userId);
  return result.ok ? providerOperationsEmpty() : providerOperationsFailure(result);
}
