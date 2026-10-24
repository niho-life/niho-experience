import { adminJson } from "@/lib/admin/server";
import {
  adminSupportCaseFailureJson,
  isAdminHttpSupportCase,
  loadAdminSupportCaseClient,
} from "@/lib/admin/case-server";

export async function GET(request: Request) {
  if (!isAdminHttpSupportCase()) return adminJson({ error: "not_found" }, 404);
  if (new URL(request.url).search) return adminJson({ error: "invalid_input" }, 400);
  const loaded = await loadAdminSupportCaseClient();
  if (!loaded.ok) return loaded.response;
  const result = await loaded.client.listSupportAdmins();
  return result.ok ? adminJson(result.data) : adminSupportCaseFailureJson(result);
}
