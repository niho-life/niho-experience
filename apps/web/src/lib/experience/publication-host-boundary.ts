import "server-only";
import { config } from "@/lib/config";
import { clearSessionCookie, hostApiClient, loadHostProviders, noStoreJson, readHostSession } from "@/lib/host/server";
import { nihoIdOrNull } from "@/lib/host/providers";
import { accessTokenUsable } from "@/lib/host/session";

type Operation = "READ" | "EDIT" | "OWNER";
const error = (code: string, status: number) => noStoreJson({ error: { code } }, status);

/**
 * Publication uses a dedicated identity boundary. It never borrows ownerUserId
 * from provider registration as the current account and never reaches the store
 * until A exposes a stable auth user ID plus a seller/Connect mapping.
 */
export async function publicationHostBoundary(providerId: unknown, operation: Operation): Promise<Response> {
  if (!config.experiencePublicationsEnabled || config.apiMode !== "http" || !config.hostConsoleEnabled) return error("NOT_FOUND", 404);
  const id = nihoIdOrNull(providerId);
  if (!id) return error("INVALID_INPUT", 400);
  const session = await readHostSession();
  if (!session) return error("SESSION_ENDED", 401);
  if (!accessTokenUsable(session, Date.now())) return error("SESSION_REFRESH_REQUIRED", 401);

  const providers = await loadHostProviders();
  if (providers.status === "signed-out" || providers.status === "rejected") return error("SESSION_ENDED", 401);
  if (providers.status === "refresh") return error("SESSION_REFRESH_REQUIRED", 401);
  if (providers.status !== "ok") return error("READINESS_UNAVAILABLE", 502);
  const provider = providers.providers.find((item) => item.id === id);
  if (!provider) return error("NOT_FOUND", 404);
  const role = provider.memberRole;
  if (role !== "OWNER" && role !== "EDITOR") return error("FORBIDDEN", 403);
  if (operation === "OWNER" && role !== "OWNER") return error("FORBIDDEN", 403);

  const client = hostApiClient(session);
  const identity = await client.getAuthMe();
  if (!identity.ok) {
    if (identity.kind === "error" && identity.status === 401) {
      const response = error("SESSION_ENDED", 401);
      clearSessionCookie(response);
      return response;
    }
    if (identity.kind === "error" && identity.status === 403) return error("FORBIDDEN", 403);
    return error("READINESS_UNAVAILABLE", 502);
  }

  if (role === "OWNER") {
    const readiness = await client.getExperienceProviderPaymentReadiness(id);
    if (!readiness.ok) {
      if (readiness.kind === "error" && readiness.status === 401) {
        const response = error("SESSION_ENDED", 401);
        clearSessionCookie(response);
        return response;
      }
      if (readiness.kind === "error" && readiness.status === 403) return error("FORBIDDEN", 403);
      return error("READINESS_UNAVAILABLE", 502);
    }
  }

  // readAuthMe/readReadiness deliberately project only today's public client
  // fields. Thus the current contract cannot furnish a mutation-capable actor
  // or prove that the product's Connect reference is the ready NIHO seller.
  // Keep this response closed until the versioned A fields are added to the
  // NIHO OpenAPI and validated by @niho-experience/api-client/host.
  return error("AUTH_CONTRACT_UNAVAILABLE", 503);
}

export const publicationHostMutationAllowed = (request: Request): boolean => {
  if (request.method === "GET" || request.method === "HEAD") return true;
  const expected = new URL(config.siteUrl).origin;
  return request.headers.get("origin") === expected && request.headers.get("sec-fetch-site") === "same-origin";
};
