import { adminJson } from "@/lib/admin/server";
import { adminFeeSummaryFailureJson, isAdminFeeSummaryEnabled, loadAdminFeeSummaryClient } from "@/lib/admin/fee-summary-server";

type Context = { params: Promise<{ bookingId: string }> };

export async function GET(request: Request, { params }: Context) {
  if (!isAdminFeeSummaryEnabled()) return adminJson({ error: "not_found" }, 404);
  if (new URL(request.url).search) return adminJson({ error: "invalid_input" }, 400);
  const loaded = await loadAdminFeeSummaryClient();
  if (!loaded.ok) return loaded.response;
  const { bookingId } = await params;
  const result = await loaded.client.read(bookingId);
  return result.ok ? adminJson(result.data) : adminFeeSummaryFailureJson(result);
}

