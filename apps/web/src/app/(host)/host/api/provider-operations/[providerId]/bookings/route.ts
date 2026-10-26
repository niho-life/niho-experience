import { EXPERIENCE_PROVIDER_BOOKING_STATUSES, type ExperienceProviderBookingListQuery } from "@niho-experience/api-client/experience-provider-operations";
import { isExperienceProviderBookingCursor, isExperienceProviderOperationPathId } from "@niho-experience/api-client/experience-provider-operations-schema";
import { loadProviderOperationsClient, providerOperationsFailure, providerOperationsJson } from "@/lib/host/provider-operations-server";

type Context = { params: Promise<{ providerId: string }> };
const DATE = /^\d{4}-\d{2}-\d{2}$/;
export async function GET(request: Request, context: Context) {
  const { providerId } = await context.params;
  if (!isExperienceProviderOperationPathId(providerId)) return providerOperationsJson({ error: "not_found" }, 404);
  const search = new URL(request.url).searchParams;
  if ([...search.keys()].some((key) => !["cursor", "pageId", "fromDate", "toDate", "status"].includes(key)) || [...search.keys()].some((key) => search.getAll(key).length !== 1)) return providerOperationsJson({ error: "invalid_query" }, 400);
  const query: ExperienceProviderBookingListQuery = {};
  const cursor = search.get("cursor"); const pageId = search.get("pageId"); const fromDate = search.get("fromDate"); const toDate = search.get("toDate"); const status = search.get("status");
  if (cursor !== null) { if (!isExperienceProviderBookingCursor(cursor)) return providerOperationsJson({ error: "invalid_query" }, 400); query.cursor = cursor; }
  if (pageId !== null) { if (!isExperienceProviderOperationPathId(pageId)) return providerOperationsJson({ error: "invalid_query" }, 400); query.pageId = pageId; }
  if (fromDate !== null) { if (!DATE.test(fromDate)) return providerOperationsJson({ error: "invalid_query" }, 400); query.fromDate = fromDate; }
  if (toDate !== null) { if (!DATE.test(toDate)) return providerOperationsJson({ error: "invalid_query" }, 400); query.toDate = toDate; }
  if (status !== null) { if (!EXPERIENCE_PROVIDER_BOOKING_STATUSES.includes(status as typeof EXPERIENCE_PROVIDER_BOOKING_STATUSES[number])) return providerOperationsJson({ error: "invalid_query" }, 400); query.status = status as typeof EXPERIENCE_PROVIDER_BOOKING_STATUSES[number]; }
  const loaded = await loadProviderOperationsClient(); if (!loaded.ok) return loaded.response;
  const result = await loaded.client.listBookings(providerId, query);
  return result.ok ? providerOperationsJson(result.data) : providerOperationsFailure(result);
}
