import "server-only";

import { createExperienceFeeSummaryApiClient, type ExperienceFeeSummaryFailure } from "@niho-experience/api-client/fee-summary-server";
import { config } from "@/lib/config";
import { idTokenUsable } from "./session";
import { clearSessionCookie, hostNotFound, noStoreJson, readHostSession } from "./server";

export const isHostFeeSummaryEnabled = () => config.apiMode === "http" && config.hostConsoleEnabled && config.experienceFeeSummaryApiEnabled;
export const isHostFeeSummaryPreview = () => config.apiMode === "mock" && config.hostConsoleEnabled && config.experienceFeeSummaryPreviewEnabled;
export const isHostFeeSummaryUiEnabled = () => isHostFeeSummaryEnabled() || isHostFeeSummaryPreview();

export function hostFeeSummaryFailureJson(failure: ExperienceFeeSummaryFailure) {
  if (failure.kind === "rejected") {
    const response = noStoreJson({ error: failure.status === 401 ? "session_refresh_required" : "forbidden" }, failure.status);
    clearSessionCookie(response);
    return response;
  }
  if (failure.kind === "invalid_request") return noStoreJson({ error: "invalid_input" }, 400);
  if (failure.kind === "not_found") return noStoreJson({ error: "not_found" }, 404);
  return noStoreJson({ error: "unavailable" }, 503);
}

/** Uses only the sealed host session; NIHO remains the owner/role authority for both host kinds. */
export async function loadHostFeeSummaryClient() {
  if (!isHostFeeSummaryEnabled()) return { ok: false as const, response: hostNotFound() };
  const session = await readHostSession();
  if (!session) return { ok: false as const, response: noStoreJson({ error: "unauthenticated" }, 401) };
  if (!idTokenUsable(session, Date.now())) return { ok: false as const, response: noStoreJson({ error: "session_refresh_required" }, 401) };
  return { ok: true as const, client: createExperienceFeeSummaryApiClient({ nihoWebOrigin: config.nihoWebOrigin, idToken: session.idToken, audience: "host", fetch }) };
}
