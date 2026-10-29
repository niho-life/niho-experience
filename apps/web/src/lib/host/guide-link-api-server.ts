import "server-only";
import { NextResponse } from "next/server";
import type { GuideActor, GuideRepository } from "@niho-experience/experience-store";
import { config } from "@/lib/config";
import { guideRepository } from "@/lib/experience/store-server";
import { isEditorConsole } from "@/lib/editor/server";
import { clearSessionCookie, hostApiClient, noStoreJson, readHostSession } from "./server";
import { idTokenUsable, type HostSession } from "./session";

type HostGuideLinkContext = { actor: GuideActor; repository: GuideRepository; session: HostSession };

/** NIHO session liveness and account identity are checked on every host invitation request. */
export async function loadHostGuideLinkContext(): Promise<
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
  if (!idTokenUsable(session, Date.now())) {
    return { ok: false, response: noStoreJson({ error: "refresh_required" }, 401) };
  }
  try {
    const result = await hostApiClient(session).getAuthMe();
    if (!result.ok) {
      if (result.kind !== "network_error" && result.status === 401) {
        const response = noStoreJson({ error: "signed_out" }, 401);
        clearSessionCookie(response);
        return { ok: false, response };
      }
      return { ok: false, response: noStoreJson({ error: "unavailable" }, 503) };
    }
    if (result.data.user.id !== session.nihoUserId) {
      const response = noStoreJson({ error: "signed_out" }, 401);
      clearSessionCookie(response);
      return { ok: false, response };
    }
  } catch {
    return { ok: false, response: noStoreJson({ error: "unavailable" }, 503) };
  }
  const repository = guideRepository();
  if (!repository) return { ok: false, response: noStoreJson({ error: "unavailable" }, 503) };
  return { ok: true, value: { actor: { nihoUserId: session.nihoUserId }, repository, session } };
}
