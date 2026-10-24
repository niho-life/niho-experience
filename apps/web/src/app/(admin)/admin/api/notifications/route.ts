import { decodeExperienceAdminNotificationReadRequest } from "@niho-experience/api-client/admin-read-schema";
import { adminJson, adminMutationAllowed, adminReadFailureJson, isAdminHttpRead, loadAdminReadClient } from "@/lib/admin/server";

const QUERY_KEYS = new Set(["cursor", "unread", "limit"]);

export async function GET(request: Request) {
  if (!isAdminHttpRead()) return adminJson({ error: "not_found" }, 404);
  const params = new URL(request.url).searchParams;
  if ([...params.keys()].some((key) => !QUERY_KEYS.has(key))) return adminJson({ error: "invalid_input" }, 400);
  if ([...QUERY_KEYS].some((key) => params.getAll(key).length > 1)) return adminJson({ error: "invalid_input" }, 400);
  const cursor = params.get("cursor") ?? undefined;
  const unreadRaw = params.get("unread");
  const limitRaw = params.get("limit");
  if (unreadRaw !== null && unreadRaw !== "true" && unreadRaw !== "false") return adminJson({ error: "invalid_input" }, 400);
  if (limitRaw !== null && !/^[1-9]\d{0,2}$/.test(limitRaw)) return adminJson({ error: "invalid_input" }, 400);
  const limit = limitRaw === null ? 50 : Number(limitRaw);
  if (limit > 100) return adminJson({ error: "invalid_input" }, 400);
  const loaded = await loadAdminReadClient();
  if (!loaded.ok) return loaded.response;
  const result = await loaded.client.listNotifications({ cursor, unread: unreadRaw === "true", limit });
  return result.ok ? adminJson(result.data) : adminReadFailureJson(result);
}

export async function POST(request: Request) {
  if (!isAdminHttpRead()) return adminJson({ error: "not_found" }, 404);
  if (!adminMutationAllowed(request)) return adminJson({ error: "forbidden" }, 403);
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
  const decoded = decodeExperienceAdminNotificationReadRequest(body);
  if (!decoded) return adminJson({ error: "invalid_input" }, 400);
  const result = await loaded.client.markNotificationsRead(decoded);
  return result.ok ? adminJson(result.data) : adminReadFailureJson(result);
}
