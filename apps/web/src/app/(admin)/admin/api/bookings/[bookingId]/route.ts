import { adminJson, adminReadFailureJson, isAdminHttpRead, loadAdminReadClient } from "@/lib/admin/server";

export async function GET(request: Request, { params }: { params: Promise<{ bookingId: string }> }) {
  if (!isAdminHttpRead()) return adminJson({ error: "not_found" }, 404);
  if (new URL(request.url).search) return adminJson({ error: "invalid_input" }, 400);
  const loaded = await loadAdminReadClient();
  if (!loaded.ok) return loaded.response;
  const { bookingId } = await params;
  const result = await loaded.client.getBooking(bookingId);
  return result.ok ? adminJson(result.data) : adminReadFailureJson(result);
}
