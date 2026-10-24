import type { AdminOperation } from "@/admin/bookings";
import { runAdminPreviewOperation } from "@/admin/preview-store";
import { adminJson, adminMutationAllowed, isAdminPreview, readAdminSession } from "@/lib/admin/server";

function operationOf(value: unknown): AdminOperation | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const reason = typeof input.reason === "string" && input.reason.length <= 2000 ? input.reason : null;
  if (!reason) return null;
  if (input.action === "approve" || input.action === "decline" || input.action === "contact") return { action: input.action, reason };
  if (input.action !== "cancel" || !input.cancellation || typeof input.cancellation !== "object") return null;
  const cancellation = input.cancellation as Record<string, unknown>;
  const refund = cancellation.refund === "full" || cancellation.refund === "half" || cancellation.refund === "none" ? cancellation.refund : null;
  const cancelReason = cancellation.reason === "host" || cancellation.reason === "guest" || cancellation.reason === "other" ? cancellation.reason : null;
  const message = typeof cancellation.message === "string" && cancellation.message.length <= 2000 ? cancellation.message : null;
  return refund && cancelReason && message !== null ? { action: "cancel", reason, cancellation: { refund, reason: cancelReason, message } } : null;
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
  if (!body || typeof body !== "object" || Array.isArray(body)) return adminJson({ error: "invalid_input" }, 400);
  const input = body as Record<string, unknown>;
  const bookingId = typeof input.bookingId === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(input.bookingId) ? input.bookingId : null;
  const key = request.headers.get("idempotency-key");
  const operation = operationOf(input.operation);
  if (!bookingId || !key || !/^[A-Za-z0-9_-]{8,100}$/.test(key) || !operation) return adminJson({ error: "invalid_input" }, 400);
  const result = runAdminPreviewOperation(session.id, session.expiresAt, bookingId, key, operation, { id: session.actorId, name: session.actorName });
  return result.ok ? adminJson(result) : adminJson({ error: "operation_refused", message: result.message }, result.status);
}
