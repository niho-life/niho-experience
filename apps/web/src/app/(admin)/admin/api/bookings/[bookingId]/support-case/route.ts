import { decodeExperienceAdminSupportCasePatchRequest } from "@niho-experience/api-client/admin-support-case-schema";
import { adminMutationAllowed, adminJson } from "@/lib/admin/server";
import {
  adminSupportCaseFailureJson,
  isAdminHttpSupportCase,
  loadAdminSupportCaseClient,
} from "@/lib/admin/case-server";

type Context = { params: Promise<{ bookingId: string }> };

export async function GET(request: Request, { params }: Context) {
  if (!isAdminHttpSupportCase()) return adminJson({ error: "not_found" }, 404);
  if (new URL(request.url).search) return adminJson({ error: "invalid_input" }, 400);
  const loaded = await loadAdminSupportCaseClient();
  if (!loaded.ok) return loaded.response;
  const { bookingId } = await params;
  const result = await loaded.client.getSupportCase(bookingId);
  return result.ok ? adminJson(result.data) : adminSupportCaseFailureJson(result);
}

export async function PATCH(request: Request, { params }: Context) {
  if (!isAdminHttpSupportCase()) return adminJson({ error: "not_found" }, 404);
  if (!adminMutationAllowed(request)) return adminJson({ error: "forbidden" }, 403);
  if (new URL(request.url).search) return adminJson({ error: "invalid_input" }, 400);
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") return adminJson({ error: "invalid_input" }, 400);
  let body: unknown;
  try { body = await request.json(); } catch { return adminJson({ error: "invalid_input" }, 400); }
  const decoded = decodeExperienceAdminSupportCasePatchRequest(body);
  if (!decoded) return adminJson({ error: "invalid_input" }, 400);
  const loaded = await loadAdminSupportCaseClient();
  if (!loaded.ok) return loaded.response;
  const { bookingId } = await params;
  const result = await loaded.client.patchSupportCase(bookingId, decoded);
  return result.ok ? adminJson(result.data) : adminSupportCaseFailureJson(result);
}
