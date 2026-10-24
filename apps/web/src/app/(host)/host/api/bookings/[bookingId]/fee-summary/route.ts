import { hostFeeSummaryFailureJson, isHostFeeSummaryEnabled, loadHostFeeSummaryClient } from "@/lib/host/fee-summary-server";
import { hostNotFound, noStoreJson } from "@/lib/host/server";

type Context = { params: Promise<{ bookingId: string }> };

export async function GET(request: Request, { params }: Context) {
  if (!isHostFeeSummaryEnabled()) return hostNotFound();
  if (new URL(request.url).search) return noStoreJson({ error: "invalid_input" }, 400);
  const loaded = await loadHostFeeSummaryClient();
  if (!loaded.ok) return loaded.response;
  const { bookingId } = await params;
  const result = await loaded.client.read(bookingId);
  if (!result.ok) return hostFeeSummaryFailureJson(result);
  const summary = result.data.feeSummary;
  return noStoreJson({ feeSummary: {
    ...summary,
    reason: null,
    accounting: summary.accounting ? { ...summary.accounting, netNihoCashYen: null } : null,
  } });
}

