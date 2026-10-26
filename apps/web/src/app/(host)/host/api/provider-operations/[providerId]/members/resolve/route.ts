import { decodeExperienceProviderResolveMemberInput, isExperienceProviderOperationPathId } from "@niho-experience/api-client/experience-provider-operations-schema";
import { loadProviderOperationsClient, providerOperationsFailure, providerOperationsJson, providerOperationsMutationAllowed, readProviderOperationsJson } from "@/lib/host/provider-operations-server";

type Context = { params: Promise<{ providerId: string }> };
export async function POST(request: Request, context: Context) {
  const { providerId } = await context.params;
  if (new URL(request.url).search || !isExperienceProviderOperationPathId(providerId)) return providerOperationsJson({ error: "not_found" }, 404);
  if (!providerOperationsMutationAllowed(request)) return providerOperationsJson({ error: "forbidden" }, 403);
  const body = await readProviderOperationsJson(request, 1024);
  const input = body.ok ? decodeExperienceProviderResolveMemberInput(body.value) : null;
  if (!input) return providerOperationsJson({ error: "invalid_input" }, 400);
  const loaded = await loadProviderOperationsClient();
  if (!loaded.ok) return loaded.response;
  const result = await loaded.client.resolveMember(providerId, input);
  return result.ok ? providerOperationsJson(result.data) : providerOperationsFailure(result);
}
