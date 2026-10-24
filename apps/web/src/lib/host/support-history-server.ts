import "server-only";
import { createExperienceHostSupportHistoryApiClient, type ExperienceHostSupportHistoryFailure } from "@niho-experience/api-client/host-support-history";
import { config } from "@/lib/config";
import { idTokenUsable } from "./session";
import { hostNotFound, noStoreJson, readHostSession } from "./server";

export const isHostSupportHistoryEnabled = () => config.apiMode === "http" && config.hostConsoleEnabled && config.hostSupportHistoryApiEnabled;

export function hostSupportHistoryFailureJson(failure: ExperienceHostSupportHistoryFailure) {
  if (failure.kind === "rejected") return noStoreJson({ error: failure.status === 401 ? "session_refresh_required" : "forbidden" }, failure.status);
  if (failure.kind === "invalid_request") return noStoreJson({ error: "invalid_input" }, 400);
  if (failure.kind === "not_found") return noStoreJson({ error: "not_found" }, 404);
  return noStoreJson({ error: "unavailable" }, 503);
}

/** Fixed read-only BFF. NIHO validates that either host kind owns the booking. */
export async function loadHostSupportHistoryClient() {
  if (!isHostSupportHistoryEnabled()) return { ok: false as const, response: hostNotFound() };
  const session = await readHostSession();
  if (!session) return { ok: false as const, response: noStoreJson({ error: "unauthenticated" }, 401) };
  if (!idTokenUsable(session, Date.now())) return { ok: false as const, response: noStoreJson({ error: "session_refresh_required" }, 401) };
  return { ok: true as const, client: createExperienceHostSupportHistoryApiClient({ nihoWebOrigin: config.nihoWebOrigin, idToken: session.idToken, fetch }) };
}
