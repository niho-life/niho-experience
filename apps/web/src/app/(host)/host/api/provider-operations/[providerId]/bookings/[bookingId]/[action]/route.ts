import { decodeExperienceProviderMessageInput, isExperienceProviderOperationPathId } from "@niho-experience/api-client/experience-provider-operations-schema";
import { projectHostMessageReceipt } from "@/host/live-bookings";
import { loadProviderOperationsClient, providerOperationsFailure, providerOperationsJson, providerOperationsMutationAllowed, readProviderOperationsJson } from "@/lib/host/provider-operations-server";

type Context = { params: Promise<{ providerId: string; bookingId: string; action: string }> };
export async function POST(request: Request, context: Context) {
  const { providerId, bookingId, action } = await context.params;
  if (new URL(request.url).search || !["approve", "decline", "message"].includes(action) || !isExperienceProviderOperationPathId(providerId) || !isExperienceProviderOperationPathId(bookingId)) return providerOperationsJson({ error: "not_found" }, 404);
  if (!providerOperationsMutationAllowed(request)) return providerOperationsJson({ error: "forbidden" }, 403);
  const body = await readProviderOperationsJson(request, 8 * 1024);
  if (!body.ok || typeof body.value !== "object" || body.value === null || Array.isArray(body.value)) return providerOperationsJson({ error: "invalid_input" }, 400);
  const value = body.value as Record<string, unknown>; const pageId = value.pageId;
  if (!isExperienceProviderOperationPathId(pageId)) return providerOperationsJson({ error: "invalid_input" }, 400);
  const loaded = await loadProviderOperationsClient(); if (!loaded.ok) return loaded.response;
  if (action === "approve" || action === "decline") {
    if (Object.keys(value).length !== 1) return providerOperationsJson({ error: "invalid_input" }, 400);
    const result = action === "approve" ? await loaded.client.approveBooking(providerId, pageId, bookingId) : await loaded.client.declineBooking(providerId, pageId, bookingId);
    return result.ok ? providerOperationsJson(result.data) : providerOperationsFailure(result);
  }
  if (Object.keys(value).length !== 3) return providerOperationsJson({ error: "invalid_input" }, 400);
  const input = decodeExperienceProviderMessageInput({ subject: value.subject, body: value.body });
  if (!input) return providerOperationsJson({ error: "invalid_input" }, 400);
  const result = await loaded.client.messageGuest(providerId, pageId, bookingId, input);
  return result.ok ? providerOperationsJson(projectHostMessageReceipt(result.data), 201) : providerOperationsFailure(result);
}
