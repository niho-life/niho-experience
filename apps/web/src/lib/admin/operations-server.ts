import "server-only";
import { createExperienceAdminOperationsApiClient, type ExperienceAdminOperationsApiClient, type ExperienceAdminOperationsFailure } from "@niho-experience/api-client/admin-operations";
import { config } from "@/lib/config";
import { adminJson, clearAdminHttpSessionCookie, isAdminHttp, isAdminHttpRead, isAdminPreview, isAdminReadPreview, loadAdminHttpSession } from "./server";

export const isAdminHttpOperations = () => isAdminHttpRead() && config.adminOperationsApiEnabled;
export const isAdminOperationsPreview = () => isAdminReadPreview() && config.adminOperationsPreviewEnabled;
export const isAdminOperationsUiEnabled = () => isAdminHttpOperations() || (isAdminPreview() && isAdminOperationsPreview());

export function adminOperationsFailureJson(failure: ExperienceAdminOperationsFailure) {
  if (failure.kind === "rejected") { const response = adminJson({ error: "signed_out" }, 401); clearAdminHttpSessionCookie(response); return response; }
  if (failure.kind === "invalid_request") return adminJson({ error: "invalid_input" }, 400);
  if (failure.kind === "not_found") return adminJson({ error: "not_found" }, 404);
  if (failure.kind === "conflict") return adminJson({ error: "conflict", reason: failure.reason }, 409);
  if (failure.kind === "operation_id_reused") return adminJson({ error: "operation_id_reused" }, 409);
  return adminJson({ error: "unavailable" }, 503);
}

/** Every operations BFF call re-verifies the dedicated current ADMIN session. */
export async function loadAdminOperationsClient(): Promise<{ ok: true; client: ExperienceAdminOperationsApiClient } | { ok: false; response: Response }> {
  if (!isAdminHttpOperations() || !isAdminHttp()) return { ok: false, response: adminJson({ error: "not_found" }, 404) };
  const load = await loadAdminHttpSession();
  if (load.status === "ok") return { ok: true, client: createExperienceAdminOperationsApiClient({ nihoWebOrigin: config.nihoWebOrigin, idToken: load.session.idToken, fetch }) };
  if (load.status === "error") return { ok: false, response: adminJson({ error: "unavailable" }, 503) };
  const response = adminJson({ error: load.status === "refresh" ? "refresh_required" : "signed_out" }, 401);
  if (load.status === "rejected") clearAdminHttpSessionCookie(response);
  return { ok: false, response };
}
