import "server-only";
import { StoreAccessDeniedError, StoreConflictError, StoreNotFoundError, StoreRateLimitedError, StoreValidationError, type HostTeamRepository } from "@niho-experience/experience-store";
import { config } from "@/lib/config";
import { hostTeamRepository } from "@/lib/experience/store-server";
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
