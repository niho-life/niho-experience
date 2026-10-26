import { decodeExperienceProviderUploadPolicyRequest } from "@niho-experience/api-client/host-schema";
import { isExperienceProviderOperationPathId } from "@niho-experience/api-client/experience-provider-operations-schema";
import type { ExperienceProviderPhotoUploadForm, ExperienceProviderUploadPolicyResponse } from "@niho-experience/api-client/host";
import { loadProviderPagesClient, providerPagesFailure } from "@/lib/host/provider-pages-server";
import { providerOperationsJson, providerOperationsMutationAllowed, readProviderOperationsJson } from "@/lib/host/provider-operations-server";

type Context = { params: Promise<{ providerId: string }> };
function browserUploadForm(policy: ExperienceProviderUploadPolicyResponse): ExperienceProviderPhotoUploadForm {
  return { url: policy.upload.url, fields: { ...policy.upload.fields }, objectKey: policy.objectKey, expiresAt: policy.expiresAt, maxSizeBytes: policy.maxSizeBytes };
}
export async function POST(request: Request, context: Context) {
  const { providerId } = await context.params;
  if (new URL(request.url).search || !isExperienceProviderOperationPathId(providerId)) return providerOperationsJson({ error: "not_found" }, 404);
  if (!providerOperationsMutationAllowed(request)) return providerOperationsJson({ error: "forbidden" }, 403);
  const body = await readProviderOperationsJson(request, 1024); const input = body.ok ? decodeExperienceProviderUploadPolicyRequest(body.value) : null;
  if (!input) return providerOperationsJson({ error: "invalid_input" }, 400);
  const loaded = await loadProviderPagesClient(); if (!loaded.ok) return loaded.response;
  const result = await loaded.client.createExperienceProviderUploadPolicy(providerId, input);
  return result.ok ? providerOperationsJson(browserUploadForm(result.data), 201) : providerPagesFailure(result);
}
