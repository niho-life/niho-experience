import "server-only";

import { createExperienceFeeSummaryApiClient, type ExperienceFeeSummaryFailure } from "@niho-experience/api-client/fee-summary-server";
import { config } from "@/lib/config";
import { adminJson, clearAdminHttpSessionCookie, isAdminHttp, isAdminReadPreview, loadAdminHttpSession } from "./server";

export const isAdminFeeSummaryEnabled = () => isAdminHttp() && config.experienceFeeSummaryApiEnabled;
export const isAdminFeeSummaryPreview = () => isAdminReadPreview() && config.experienceFeeSummaryPreviewEnabled;
export const isAdminFeeSummaryUiEnabled = () => isAdminFeeSummaryEnabled() || isAdminFeeSummaryPreview();

export function adminFeeSummaryFailureJson(failure: ExperienceFeeSummaryFailure) {
  if (failure.kind === "rejected") {
    const response = adminJson({ error: failure.status === 401 ? "signed_out" : "forbidden" }, failure.status);
    clearAdminHttpSessionCookie(response);
    return response;
  }
  if (failure.kind === "invalid_request") return adminJson({ error: "invalid_input" }, 400);
  if (failure.kind === "not_found") return adminJson({ error: "not_found" }, 404);
  return adminJson({ error: "unavailable" }, 503);
}

/** Re-verifies the dedicated current ADMIN session for every fixed fee-summary read. */
export async function loadAdminFeeSummaryClient() {
  if (!isAdminFeeSummaryEnabled()) return { ok: false as const, response: adminJson({ error: "not_found" }, 404) };
  const load = await loadAdminHttpSession();
  if (load.status === "ok") return { ok: true as const, client: createExperienceFeeSummaryApiClient({ nihoWebOrigin: config.nihoWebOrigin, idToken: load.session.idToken, audience: "admin", fetch }) };
  if (load.status === "error") return { ok: false as const, response: adminJson({ error: "unavailable" }, 503) };
  const response = adminJson({ error: load.status === "refresh" ? "refresh_required" : "signed_out" }, 401);
  if (load.status === "rejected") clearAdminHttpSessionCookie(response);
  return { ok: false as const, response };
}

