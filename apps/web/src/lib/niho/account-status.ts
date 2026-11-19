import "server-only";
import { createNihoAccountStatusClient } from "@niho-experience/api-client/niho-account-status";
import type { NihoAccountStatusStore, NihoAccountStatusSessionKind } from "@niho-experience/experience-store";
import { config } from "@/lib/config";
import { nihoAccountStatusStore } from "@/lib/experience/store-server";
import { experienceHostServiceIdToken } from "./service-identity";

/**
 * Check a bound session at most once per 15 minutes. NIHO and token-service failures leave the session usable and
 * unstamped, so the next use retries. A malformed or partial API response is treated the same way as an outage.
 */
export async function checkNihoAccountStatusSession(
  kind: NihoAccountStatusSessionKind,
  sessionToken: string,
  store?: NihoAccountStatusStore | null,
): Promise<boolean> {
  if (!config.nihoAccountStatusCheckEnabled) return true;
  const statusStore = store === undefined ? nihoAccountStatusStore() : store;
  if (!statusStore) return true;
  const nowUtc = new Date().toISOString();
  const check = await statusStore.prepareCheck({ kind, sessionToken, nowUtc });
  if (check.kind === "session-ended") return false;
  if (check.kind !== "check") return true;

  let response;
  try {
    const serviceIdToken = await experienceHostServiceIdToken();
    const client = createNihoAccountStatusClient({
      nihoWebOrigin: config.nihoWebOrigin,
      serviceIdToken,
      fetch,
    });
    response = await client.getStatuses([check.nihoUserId]);
  } catch {
    return true;
  }
  if (!response.ok) return true;
  const result = response.results[0];
  if (!result || result.nihoUserId !== check.nihoUserId) return true;
  const applied = await statusStore.applyStatus({
    kind,
    sessionToken,
    nihoUserId: check.nihoUserId,
    result: result.status === "merged"
      ? { status: "merged", currentUserId: result.currentUserId }
      : { status: result.status },
    nowUtc: new Date().toISOString(),
  });
  if ((applied.kind === "merged" || applied.kind === "ended") && applied.conflicts.length > 0) {
    console.error(`[niho-account-status] merged identity conflict; manual reconciliation required (${applied.conflicts.join(",")})`);
  }
  if (applied.kind === "ended") return false;
  if (applied.kind === "stale") {
    // A parallel request may have completed this same transition while NIHO was responding.
    return (await statusStore.prepareCheck({ kind, sessionToken, nowUtc: new Date().toISOString() })).kind !== "session-ended";
  }
  return true;
}
