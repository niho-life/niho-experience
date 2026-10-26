import { isExperienceProviderOperationPathId } from "@niho-experience/api-client/experience-provider-operations-schema";
import { loadProviderOperationsClient, providerOperationsFailure, providerOperationsJson } from "@/lib/host/provider-operations-server";

type Context = { params: Promise<{ providerId: string; bookingId: string }> };
export async function GET(request: Request, context: Context) {
  const { providerId, bookingId } = await context.params;
  if (new URL(request.url).search || !isExperienceProviderOperationPathId(providerId) || !isExperienceProviderOperationPathId(bookingId)) return providerOperationsJson({ error: "not_found" }, 404);
  const loaded = await loadProviderOperationsClient(); if (!loaded.ok) return loaded.response;
  const result = await loaded.client.getBooking(providerId, bookingId);
  return result.ok ? providerOperationsJson(result.data) : providerOperationsFailure(result);
}
