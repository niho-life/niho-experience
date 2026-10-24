import { notificationIdsFromBody } from "@/admin/notifications";
import { adminPreviewNotifications, markAdminPreviewNotificationsRead } from "@/admin/preview-store";
import { adminJson, adminMutationAllowed, isAdminPreview, readAdminSession } from "@/lib/admin/server";

export async function GET() {
  if (!isAdminPreview()) return adminJson({ error: "not_found" }, 404);
  const session = await readAdminSession();
  if (!session) return adminJson({ error: "signed_out" }, 401);
  return adminJson(adminPreviewNotifications(session.id, session.expiresAt));
}

export async function POST(request: Request) {
  if (!isAdminPreview()) return adminJson({ error: "not_found" }, 404);
  if (!adminMutationAllowed(request)) return adminJson({ error: "forbidden" }, 403);
  const session = await readAdminSession();
  if (!session) return adminJson({ error: "signed_out" }, 401);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return adminJson({ error: "invalid_input" }, 400);
  }
  const notificationIds = notificationIdsFromBody(body);
  if (!notificationIds) return adminJson({ error: "invalid_input" }, 400);
  const result = markAdminPreviewNotificationsRead(session.id, session.expiresAt, notificationIds);
  return result.ok ? adminJson(result) : adminJson({ error: "notification_update_refused", message: result.message }, result.status);
}
