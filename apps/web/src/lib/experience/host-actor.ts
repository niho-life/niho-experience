import "server-only";
import type { HostActor } from "@niho-experience/experience-store";
import { nihoIdOrNull, type HostProviderRole } from "@/lib/host/providers";
import { loadHostProviders, noStoreJson, readHostSession } from "@/lib/host/server";
import { accessTokenUsable } from "@/lib/host/session";

/** NIHO proves the current account and host relationship; the store checks experience membership. */
export async function hostActor(providerId: unknown): Promise<{ actor: HostActor; nihoRole: HostProviderRole | null } | { response: Response }> {
  const id = nihoIdOrNull(providerId);
  if (!id) return { response: noStoreJson({ error: "invalid_provider" }, 400) };
  const session = await readHostSession();
  if (!session) return { response: noStoreJson({ error: "unauthenticated" }, 401) };
  if (!accessTokenUsable(session, Date.now())) return { response: noStoreJson({ error: "session_refresh_required" }, 401) };
  const providers = await loadHostProviders();
  if (providers.status === "rejected" || providers.status === "refresh" || providers.status === "signed-out") return { response: noStoreJson({ error: "unauthenticated" }, 401) };
  if (providers.status !== "ok") return { response: noStoreJson({ error: "identity_unavailable" }, 503) };
  const provider = providers.providers.find((entry) => entry.id === id);
  if (!provider) return { response: noStoreJson({ error: "forbidden" }, 403) };
  // NIHO app-connect does not reveal the signed-in user ID. Use this provider's
  // stable owner ID as the Experience actor for every NIHO member role; the
  // app-connect token and current NIHO role still authorize every upstream call.
  const identity = nihoIdOrNull(provider.ownerUserId);
  if (!identity) return { response: noStoreJson({ error: "identity_unavailable" }, 503) };
  const calendarRoleCeiling = provider.memberRole === "OWNER" ? "OWNER" : provider.memberRole === "EDITOR" || provider.memberRole === "COHOST" ? "EDITOR" : "VIEWER";
  return { actor: { providerId: id, nihoUserId: identity, calendarRoleCeiling }, nihoRole: provider.memberRole };
}
