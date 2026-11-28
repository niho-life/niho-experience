import "server-only";
import { isHostAccountId, StoreConflictError, StoreNotFoundError, StoreValidationError, ExperiencePublicationBlockedError } from "@niho-experience/experience-store";
import { config } from "@/lib/config";
import { adminJson, adminMutationAllowed, isAdminHttp, loadAdminHttpSession } from "@/lib/admin/server";

/*
 * 運営のホスト操作 (#711, docs/host-operations.md): the Admin API behind `/admin/hosts` and the operator CLI
 * (`provider hosts|suspend|clear-suspension`, `host-account suspend|reactivate`). Every request re-checks the Admin
 * session; a change also needs the same origin (or the CLI's sealed assertion) and a JSON body. Answers are never cached.
 */

const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/;
const REASON = /^[A-Z0-9_]{1,80}$/;

export const hostAdminEnabled = (): boolean => config.experiencePublicationsEnabled && isAdminHttp();

export const validProviderId = (value: string): boolean => PROVIDER_ID.test(value);
export const validAccountId = (value: string): boolean => isHostAccountId(value);
export const validReason = (value: unknown): value is string => typeof value === "string" && REASON.test(value);

export type HostAdminActor = { readonly nihoUserId: string };

/** The outcome of a failed store call as the API's answer. */
export function hostAdminFailure(error: unknown) {
  if (error instanceof StoreNotFoundError) return adminJson({ error: "not_found" }, 404);
  if (error instanceof ExperiencePublicationBlockedError) return adminJson({ error: "blocked", blockers: error.blockers }, 409);
  if (error instanceof StoreConflictError) return adminJson({ error: "conflict" }, 409);
  if (error instanceof StoreValidationError) return adminJson({ error: "invalid_input" }, 400);
  return adminJson({ error: "unavailable" }, 503);
}

/**
 * The common part of a read or a change: the feature is on, the request is allowed, the Admin session is current. `body`
 * is the parsed JSON object (empty for a read, and for a change without input).
 */
export async function hostAdminRun(
  request: Request,
  options: { readonly write: boolean; readonly keys?: readonly string[]; readonly required?: readonly string[] },
  action: (actor: HostAdminActor, body: Record<string, unknown>) => Promise<unknown>,
) {
  if (!hostAdminEnabled()) return adminJson({ error: "not_found" }, 404);
  let body: Record<string, unknown> = {};
  if (options.write) {
    if (!adminMutationAllowed(request)) return adminJson({ error: "forbidden" }, 403);
    if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") return adminJson({ error: "invalid_content_type" }, 415);
  }
  const loaded = await loadAdminHttpSession();
  if (loaded.status !== "ok") return adminJson({ error: loaded.status === "error" ? "unavailable" : "unauthenticated" }, loaded.status === "error" ? 503 : 401);
  if (options.write) {
    try {
      const value: unknown = await request.json();
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
      body = value as Record<string, unknown>;
    } catch { return adminJson({ error: "invalid_input" }, 400); }
    const allowed = options.keys ?? [];
    if (Object.keys(body).some((key) => !allowed.includes(key)) || (options.required ?? []).some((key) => !(key in body))) return adminJson({ error: "invalid_input" }, 400);
  } else if (new URL(request.url).search) {
    return adminJson({ error: "invalid_input" }, 400);
  }
  try {
    return adminJson(await action({ nihoUserId: loaded.actor.id }, body));
  } catch (error) {
    return hostAdminFailure(error);
  }
}
