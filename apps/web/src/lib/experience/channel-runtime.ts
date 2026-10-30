import "server-only";
import { StoreAccessDeniedError, StoreConflictError, StoreNotFoundError, StoreValidationError, type WorkerIdentity } from "@niho-experience/experience-store";
import { config } from "@/lib/config";
import { ResponseBodyTooLarge, readBoundedJson } from "@/lib/read-bounded-json";
import { channelRuntime } from "./store-server";

export const CHANNEL_BODY_LIMIT = 16 * 1024;
export const channelManagerEnabled = () => config.apiMode === "http" && process.env.EXPERIENCE_CHANNEL_MANAGER_ENABLED === "true";
/** Synthetic UI only. This never opens channel/inventory mutation routes. */
export const channelWorkspacePreviewEnabled = () => config.apiMode === "mock" && config.adminSupportConsoleEnabled && process.env.EXPERIENCE_CHANNEL_WORKSPACE_PREVIEW_ENABLED === "true";
export const channelWorkerEnabled = () => config.apiMode === "http" && process.env.EXPERIENCE_CHANNEL_RUNTIME_ENABLED === "true";
export const googleChannelDeliveryEnabled = () => channelWorkerEnabled()
  && process.env.EXPERIENCE_AIRBNB_GOOGLE_DELIVERY_ENABLED === "true";
export const googleChannelObservationEnabled = () => googleChannelDeliveryEnabled()
  && process.env.EXPERIENCE_AIRBNB_GOOGLE_OBSERVATION_ENABLED === "true";
/** Cloud Scheduler watchdog. Independent of the worker flag; it never accepts a worker bearer. */
export const channelWatchdogEnabled = () => config.apiMode === "http" && process.env.EXPERIENCE_CHANNEL_WATCHDOG_ENABLED === "true";

/** Both values are required; a partial configuration keeps the endpoint closed. */
export function channelWatchdogIdentitySettings(): { readonly audience: string; readonly serviceAccountEmail: string } | null {
  const audience = process.env.EXPERIENCE_CHANNEL_WATCHDOG_AUDIENCE?.trim() ?? "";
  const serviceAccountEmail = process.env.EXPERIENCE_CHANNEL_WATCHDOG_SERVICE_ACCOUNT_EMAIL?.trim() ?? "";
  return audience && serviceAccountEmail ? { audience, serviceAccountEmail } : null;
}

export function channelJson(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "private, no-store" } });
}

export function channelEmpty(status = 204): Response {
  return new Response(null, { status, headers: { "cache-control": "private, no-store" } });
}

export async function boundedObject(request: Request): Promise<Record<string, unknown> | Response> {
  if (new URL(request.url).search) return channelJson({ error: "invalid_input" }, 400);
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") return channelJson({ error: "invalid_input" }, 400);
  try {
    const body = await readBoundedJson(request, CHANNEL_BODY_LIMIT, { fatalUtf8: true });
    if (!body || typeof body !== "object" || Array.isArray(body)) return channelJson({ error: "invalid_input" }, 400);
    return body as Record<string, unknown>;
  } catch (error) {
    return channelJson({ error: error instanceof ResponseBodyTooLarge ? "payload_too_large" : "invalid_input" }, error instanceof ResponseBodyTooLarge ? 413 : 400);
  }
}

export async function internalContext(request: Request): Promise<{ runtime: NonNullable<ReturnType<typeof channelRuntime>>; worker: WorkerIdentity } | Response> {
  if (!channelWorkerEnabled()) return channelJson({ error: "not_found" }, 404);
  const runtime = channelRuntime();
  if (!runtime) return channelJson({ error: "runtime_unavailable" }, 503);
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ") || authorization.length > 320) return channelJson({ error: "unauthenticated" }, 401);
  try {
    return { runtime, worker: await runtime.authenticateWorker(authorization.slice(7)) };
  } catch {
    return channelJson({ error: "unauthenticated" }, 401);
  }
}

export function channelFailure(error: unknown): Response {
  if (error instanceof StoreAccessDeniedError) return channelJson({ error: "forbidden" }, 403);
  if (error instanceof StoreConflictError) return channelJson({ error: "stale" }, 409);
  if (error instanceof StoreNotFoundError) return channelJson({ error: "not_found" }, 404);
  if (error instanceof StoreValidationError) return channelJson({ error: "invalid_input" }, 400);
  if (error && typeof error === "object" && "code" in error && error.code === "23505") return channelJson({ error: "conflict" }, 409);
  return channelJson({ error: "runtime_unavailable" }, 503);
}

export function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  return Object.keys(value).every((key) => required.includes(key) || optional.includes(key)) && required.every((key) => key in value);
}
