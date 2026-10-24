import "server-only";
import {
  createExperienceAdminSupportCaseApiClient,
  type ExperienceAdminSupportCaseApiClient,
  type ExperienceAdminSupportCaseFailure,
} from "@niho-experience/api-client/admin-support-case";
import { config } from "@/lib/config";
import {
  adminJson,
  clearAdminHttpSessionCookie,
  isAdminHttp,
  isAdminHttpRead,
  isAdminPreview,
  isAdminReadPreview,
  loadAdminHttpSession,
} from "./server";

export const isAdminHttpSupportCase = () => isAdminHttpRead() && config.adminSupportCaseApiEnabled;
export const isAdminSupportCasePreview = () => isAdminReadPreview() && config.adminSupportCasePreviewEnabled;
export const isAdminSupportCaseUiEnabled = () => isAdminHttpSupportCase() || (isAdminPreview() && isAdminSupportCasePreview());

export function adminSupportCaseApiClient(idToken: string): ExperienceAdminSupportCaseApiClient {
  return createExperienceAdminSupportCaseApiClient({ nihoWebOrigin: config.nihoWebOrigin, idToken, fetch });
}

export function adminSupportCaseFailureJson(failure: ExperienceAdminSupportCaseFailure) {
  if (failure.kind === "rejected") {
    const response = adminJson({ error: "signed_out" }, 401);
    clearAdminHttpSessionCookie(response);
    return response;
  }
  if (failure.kind === "invalid_request") return adminJson({ error: "invalid_input" }, 400);
  if (failure.kind === "not_found") return adminJson({ error: "not_found" }, 404);
  if (failure.kind === "conflict") return adminJson({ error: "conflict", reason: failure.reason }, 409);
  return adminJson({ error: "unavailable" }, 503);
}

/** Re-verifies the dedicated client, current ADMIN role and absolute session on every case BFF request. */
export async function loadAdminSupportCaseClient(): Promise<{ ok: true; client: ExperienceAdminSupportCaseApiClient } | { ok: false; response: Response }> {
  if (!isAdminHttpSupportCase() || !isAdminHttp()) return { ok: false, response: adminJson({ error: "not_found" }, 404) };
  const load = await loadAdminHttpSession();
  if (load.status === "ok") return { ok: true, client: adminSupportCaseApiClient(load.session.idToken) };
  if (load.status === "error") return { ok: false, response: adminJson({ error: "unavailable" }, 503) };
  const response = adminJson({ error: load.status === "refresh" ? "refresh_required" : "signed_out" }, 401);
  if (load.status === "rejected") clearAdminHttpSessionCookie(response);
  return { ok: false, response };
}
