import "server-only";
import type { ExperienceHostApiFailure } from "@niho-experience/api-client/legacy-host";
import { config } from "@/lib/config";
import { clearSessionCookie, hostApiClient, readHostSession } from "./server";
import { accessTokenUsable } from "./session";
import { providerOperationsEnabled, providerOperationsJson } from "./provider-operations-server";

/** Legacy provider pages remain available only in the explicitly enabled synthetic preview. */
export function providerPagesEnabled(): boolean {
  return config.apiMode === "mock" && providerOperationsEnabled();
}

export async function loadProviderPagesClient() {
  if (!providerPagesEnabled()) return { ok: false as const, response: providerOperationsJson({ error: "not_found" }, 404) };
  // NIHO's API with the host's NIHO token: an Experience host account reads as signed out (its flag is refused with them).
  const current = await readHostSession();
  const session = current?.kind === "experience" ? null : current;
  if (!session) return { ok: false as const, response: providerOperationsJson({ error: "unauthenticated" }, 401) };
  if (!accessTokenUsable(session, Date.now())) return { ok: false as const, response: providerOperationsJson({ error: "session_refresh_required" }, 401) };
  try { return { ok: true as const, client: hostApiClient(session) }; }
  catch { return { ok: false as const, response: providerOperationsJson({ error: "unavailable" }, 502) }; }
}

export function providerPagesFailure(failure: ExperienceHostApiFailure) {
  if (failure.kind === "network_error") return providerOperationsJson({ error: "upstream_unavailable" }, 502);
  if (failure.kind === "unexpected_response") return providerOperationsJson({ error: "unexpected_upstream_response" }, 502);
  const response = providerOperationsJson({ error: failure.status === 404 ? "permission_ended" : failure.reason || failure.code }, failure.status);
  if (failure.status === 401) clearSessionCookie(response);
  return response;
}

export const isPageVersion = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.test(value);
