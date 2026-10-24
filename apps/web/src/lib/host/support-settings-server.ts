import "server-only";
import {
  createExperienceHostSupportSettingsApiClient,
  type ExperienceHostSupportSettingsFailure,
} from "@niho-experience/api-client/host-support-settings";
import { config } from "@/lib/config";
import { idTokenUsable } from "./session";
import { hostNotFound, noStoreJson, readHostSession } from "./server";

export const isHostSupportSettingsEnabled = () => config.apiMode === "http" && config.hostConsoleEnabled && config.hostSupportSettingsApiEnabled;
export const isHostSupportSettingsPreview = () => config.apiMode === "mock" && config.hostConsoleEnabled && config.hostSupportSettingsPreviewEnabled;

export function hostSupportSettingsFailureJson(failure: ExperienceHostSupportSettingsFailure) {
  if (failure.kind === "rejected") return noStoreJson({ error: failure.status === 401 ? "session_refresh_required" : "forbidden" }, failure.status);
  if (failure.kind === "invalid_request") return noStoreJson({ error: "invalid_input" }, 400);
  if (failure.kind === "not_found") return noStoreJson({ error: "not_found" }, 404);
  if (failure.kind === "conflict") return noStoreJson({ error: "conflict" }, 409);
  return noStoreJson({ error: "unavailable" }, 503);
}

/** Fixed Host OWNER BFF. The sealed session token never crosses into browser JavaScript. */
export async function loadHostSupportSettingsClient() {
  if (!isHostSupportSettingsEnabled()) return { ok: false as const, response: hostNotFound() };
  const session = await readHostSession();
  if (!session) return { ok: false as const, response: noStoreJson({ error: "unauthenticated" }, 401) };
  if (!idTokenUsable(session, Date.now())) return { ok: false as const, response: noStoreJson({ error: "session_refresh_required" }, 401) };
  return { ok: true as const, client: createExperienceHostSupportSettingsApiClient({ nihoWebOrigin: config.nihoWebOrigin, idToken: session.idToken, fetch }) };
}
