import "server-only";
import { NextResponse } from "next/server";
import type { GuideActor, GuideRepository } from "@niho-experience/experience-store";
import { config } from "@/lib/config";
import { guideRepository } from "@/lib/experience/store-server";
import { isEditorConsole } from "@/lib/editor/server";
import { clearSessionCookie, hostApiClient, noStoreJson, readHostSession } from "./server";
import { accessTokenUsable, type HostSession } from "./session";

type HostGuideLinkContext = { actor: GuideActor; repository: GuideRepository; session: HostSession };

/** NIHO session liveness and account identity are checked on every host invitation request. */
export async function loadHostGuideLinkContext(providerId?: string): Promise<
  | { ok: true; value: HostGuideLinkContext }
  | { ok: false; response: NextResponse }
> {
  if (!config.hostConsoleEnabled || !isEditorConsole()) {
    return { ok: false, response: noStoreJson({ error: "not_found" }, 404) };
  }
  let session: Awaited<ReturnType<typeof readHostSession>>;
  try {
    session = await readHostSession();
  } catch {
    return { ok: false, response: noStoreJson({ error: "unavailable" }, 503) };
  }
  if (!session) return { ok: false, response: noStoreJson({ error: "signed_out" }, 401) };
  if (!accessTokenUsable(session, Date.now())) {
    return { ok: false, response: noStoreJson({ error: "refresh_required" }, 401) };
  }
  let owners: { id: string; ownerUserId: string }[];
  try {
    const result = await hostApiClient(session).listExperienceProviders();
    if (!result.ok) {
      if (result.kind !== "network_error" && result.status === 401) {
        const response = noStoreJson({ error: "signed_out" }, 401);
        clearSessionCookie(response);
        return { ok: false, response };
      }
      return { ok: false, response: noStoreJson({ error: "unavailable" }, 503) };
    }
    owners = result.data.providers.filter((provider) => provider.memberRole === "OWNER").map((provider) => ({ id: provider.id, ownerUserId: provider.ownerUserId }));
  } catch {
    return { ok: false, response: noStoreJson({ error: "unavailable" }, 503) };
  }
  const matchingOwners = providerId === undefined ? owners : owners.filter((provider) => provider.id === providerId);
  const ownerIds = [...new Set(matchingOwners.map((provider) => provider.ownerUserId))];
  if (!matchingOwners.length || ownerIds.length !== 1) return { ok: false, response: noStoreJson({ error: ownerIds.length > 1 ? "identity_unavailable" : "forbidden" }, ownerIds.length > 1 ? 503 : 403) };
  const repository = guideRepository();
  if (!repository) return { ok: false, response: noStoreJson({ error: "unavailable" }, 503) };
  return { ok: true, value: { actor: { nihoUserId: ownerIds[0]! }, repository, session } };
}
