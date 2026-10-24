import { hostSupportHistoryFailureJson, isHostSupportHistoryEnabled, loadHostSupportHistoryClient } from "@/lib/host/support-history-server";
import { hostNotFound, noStoreJson } from "@/lib/host/server";
type Context = { params: Promise<{ bookingId: string; operationId: string }> };
export async function GET(request: Request, { params }: Context) {
  if (!isHostSupportHistoryEnabled()) return hostNotFound();
  if (new URL(request.url).search) return noStoreJson({ error: "invalid_input" }, 400);
  const loaded = await loadHostSupportHistoryClient(); if (!loaded.ok) return loaded.response;
  const { bookingId, operationId } = await params; const result = await loaded.client.get(bookingId, operationId);
  return result.ok ? noStoreJson(result.data) : hostSupportHistoryFailureJson(result);
}
