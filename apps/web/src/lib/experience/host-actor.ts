import "server-only";
import type { HostActor } from "@niho-experience/experience-store";
import { nihoIdOrNull } from "@/lib/host/providers";
import { loadHostProviders, noStoreJson, readHostSession } from "@/lib/host/server";
import { idTokenUsable } from "@/lib/host/session";

/** NIHO proves the current account and host relationship; the store checks experience membership. */
export async function hostActor(providerId: unknown): Promise<{ actor: HostActor } | { response: Response }> {
  const id = nihoIdOrNull(providerId);
  if (!id) return { response: noStoreJson({ error: "invalid_provider" }, 400) };
  const session = await readHostSession();
  if (!session) return { response: noStoreJson({ error: "unauthenticated" }, 401) };
  if (!idTokenUsable(session, Date.now())) return { response: noStoreJson({ error: "session_refresh_required" }, 401) };
  const providers = await loadHostProviders();
  if (providers.status === "rejected" || providers.status === "refresh" || providers.status === "signed-out") return { response: noStoreJson({ error: "unauthenticated" }, 401) };
  if (providers.status !== "ok") return { response: noStoreJson({ error: "identity_unavailable" }, 503) };
  if (!providers.providers.some((provider) => provider.id === id)) return { response: noStoreJson({ error: "forbidden" }, 403) };
  return { actor: { providerId: id, nihoUserId: session.nihoUserId } };
}
