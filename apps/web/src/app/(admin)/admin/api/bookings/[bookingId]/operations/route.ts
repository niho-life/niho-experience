import { decodeExperienceAdminOperationRequest, type ExperienceAdminOperationAction } from "@niho-experience/api-client/admin-operations";
import { readBoundedJson } from "@/lib/read-bounded-json";
import { adminMutationAllowed, adminJson } from "@/lib/admin/server";
import { adminOperationsFailureJson, isAdminHttpOperations, loadAdminOperationsClient } from "@/lib/admin/operations-server";
type Context = { params: Promise<{ bookingId: string }> };
const ACTIONS = ["APPROVE", "DECLINE", "CANCEL", "MESSAGE"] as const;

export async function GET(request: Request, { params }: Context) {
  if (!isAdminHttpOperations()) return adminJson({ error: "not_found" }, 404);
  if (new URL(request.url).search) return adminJson({ error: "invalid_input" }, 400);
  const loaded = await loadAdminOperationsClient(); if (!loaded.ok) return loaded.response;
  const { bookingId } = await params; const result = await loaded.client.getSnapshot(bookingId);
  return result.ok ? adminJson(result.data) : adminOperationsFailureJson(result);
}

export async function POST(request: Request, { params }: Context) {
  if (!isAdminHttpOperations()) return adminJson({ error: "not_found" }, 404);
  if (!adminMutationAllowed(request)) return adminJson({ error: "forbidden" }, 403);
  if (new URL(request.url).search || Number(request.headers.get("content-length") ?? 0) > 32_768 || request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") return adminJson({ error: "invalid_input" }, 400);
  let body: unknown; try { body = await readBoundedJson(request, 32_768); } catch { return adminJson({ error: "invalid_input" }, 400); }
  if (typeof body !== "object" || body === null || Array.isArray(body) || Object.keys(body).length !== 2 || !("action" in body) || !("command" in body) || typeof body.action !== "string" || !(ACTIONS as readonly string[]).includes(body.action)) return adminJson({ error: "invalid_input" }, 400);
  const action = body.action as ExperienceAdminOperationAction; const command = decodeExperienceAdminOperationRequest(action, body.command);
  if (!command) return adminJson({ error: "invalid_input" }, 400);
  const loaded = await loadAdminOperationsClient(); if (!loaded.ok) return loaded.response;
  const { bookingId } = await params; const result = await loaded.client.execute(bookingId, action, command);
  return result.ok ? adminJson(result.data, result.status) : adminOperationsFailureJson(result);
}
