import "server-only";
import { StoreAccessDeniedError, StoreConflictError, StoreNotFoundError, StoreRateLimitedError, StoreValidationError, type HostTeamInvitations, type HostTeamRepository } from "@niho-experience/experience-store";
import { config } from "@/lib/config";
import { hostTeamInvitations, hostTeamRepository } from "@/lib/experience/store-server";
import { nihoIdOrNull } from "./providers";
import { noStoreJson, readHostSession } from "./server";
import { readBoundedJson, type BoundedJsonResult } from "./bounded-json";
import { mutationFromSameOrigin } from "./relay";

export type NativeTeamRequest = { readonly providerId: string; readonly hostAccountId: string; readonly repository: HostTeamRepository };

export async function openNativeTeam(providerId: unknown): Promise<NativeTeamRequest | { readonly response: Response }> {
  if (!config.hostTeamEnabled || !config.hostAccountsEnabled || config.apiMode !== "http") return { response: noStoreJson({ error: "not_found" }, 404) };
  const id = nihoIdOrNull(providerId);
  if (!id) return { response: noStoreJson({ error: "invalid_provider" }, 400) };
  let session: Awaited<ReturnType<typeof readHostSession>>;
  try { session = await readHostSession(); }
  catch { return { response: noStoreJson({ error: "team_unavailable" }, 503) }; }
  if (!session || session.kind !== "experience") return { response: noStoreJson({ error: "unauthenticated" }, 401) };
  const repository = hostTeamRepository();
  if (!repository) return { response: noStoreJson({ error: "team_unavailable" }, 503) };
  return { providerId: id, hostAccountId: session.hostAccountId, repository };
}

export type NativeInvitationsRequest = { readonly providerId: string; readonly hostAccountId: string; readonly invitations: HostTeamInvitations };

/** The invitations of the signed-in OWNER's provider (#636). 404 whenever EXPERIENCE_HOST_TEAM_INVITATIONS_ENABLED is off. */
export async function openNativeInvitations(providerId: unknown): Promise<NativeInvitationsRequest | { readonly response: Response }> {
  const closed = nativeInvitationsClosed();
  if (closed) return { response: closed };
  const opened = await openNativeTeam(providerId);
  if ("response" in opened) return opened;
  const invitations = hostTeamInvitations();
  if (!invitations) return { response: noStoreJson({ error: "team_unavailable" }, 503) };
  return { providerId: opened.providerId, hostAccountId: opened.hostAccountId, invitations };
}

/** The flag's own 404, for a route to answer before it reads anything else (a cross-site or malformed request included). */
export function nativeInvitationsClosed(): Response | null {
  return config.hostTeamInvitationsEnabled ? null : noStoreJson({ error: "not_found" }, 404);
}

export function nativeTeamFailure(error: unknown): Response {
  if (error instanceof StoreAccessDeniedError) return noStoreJson({ error: "forbidden" }, 403);
  if (error instanceof StoreNotFoundError) return noStoreJson({ error: "not_found" }, 404);
  if (error instanceof StoreConflictError) return noStoreJson({ error: "conflict", reload: true }, 409);
  if (error instanceof StoreValidationError) return noStoreJson({ error: "invalid_request" }, 400);
  if (error instanceof StoreRateLimitedError) {
    const response = noStoreJson({ error: "rate_limited", retryAfterSeconds: error.retryAfterSeconds }, 429);
    response.headers.set("Retry-After", String(error.retryAfterSeconds));
    return response;
  }
  return noStoreJson({ error: "team_unavailable" }, 503);
}

export const requestJson = (request: Request, limit: number): Promise<BoundedJsonResult> => readBoundedJson(request, limit);

export function nativeTeamMutationAllowed(request: Request): boolean {
  return mutationFromSameOrigin(request.method, request.headers, new URL(config.siteUrl).origin);
}
