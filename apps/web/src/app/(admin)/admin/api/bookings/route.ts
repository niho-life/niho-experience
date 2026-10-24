import { decodeExperienceAdminBookingQuery } from "@niho-experience/api-client/admin-read-schema";
import { adminJson, adminMutationAllowed, adminReadFailureJson, isAdminHttpRead, loadAdminReadClient } from "@/lib/admin/server";

export async function POST(request: Request) {
  if (!isAdminHttpRead()) return adminJson({ error: "not_found" }, 404);
  if (!adminMutationAllowed(request)) return adminJson({ error: "forbidden" }, 403);
  if (new URL(request.url).search) return adminJson({ error: "invalid_input" }, 400);
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") return adminJson({ error: "invalid_input" }, 400);
  const loaded = await loadAdminReadClient();
  if (!loaded.ok) return loaded.response;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return adminJson({ error: "invalid_input" }, 400);
  }
  const query = decodeExperienceAdminBookingQuery(body);
  if (!query) return adminJson({ error: "invalid_input" }, 400);
  const result = await loaded.client.queryBookings(query);
  return result.ok ? adminJson(result.data) : adminReadFailureJson(result);
}
