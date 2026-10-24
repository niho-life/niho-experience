import { adminJson } from "@/lib/admin/server";
import { adminOperationsFailureJson, isAdminHttpOperations, loadAdminOperationsClient } from "@/lib/admin/operations-server";
type Context = { params: Promise<{ bookingId: string; operationId: string }> };
export async function GET(request: Request, { params }: Context) {
  if (!isAdminHttpOperations()) return adminJson({ error: "not_found" }, 404);
  if (new URL(request.url).search) return adminJson({ error: "invalid_input" }, 400);
  const loaded = await loadAdminOperationsClient(); if (!loaded.ok) return loaded.response;
  const { bookingId, operationId } = await params; const result = await loaded.client.getOperation(bookingId, operationId);
  return result.ok ? adminJson(result.data) : adminOperationsFailureJson(result);
}
