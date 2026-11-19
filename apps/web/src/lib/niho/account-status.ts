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
  store: NihoAccountStatusStore | null = nihoAccountStatusStore(),
): Promise<boolean> {
  if (!config.nihoAccountStatusCheckEnabled) return true;
  if (!store) return true;
  const nowUtc = new Date().toISOString();
  const check = await store.prepareCheck({ kind, sessionToken, nowUtc });
  if (check.kind === "session-ended") return false;
  if (check.kind !== "check") return true;

  let statuses;
  try {
    const serviceIdToken = await experienceHostServiceIdToken();
    const client = createNihoAccountStatusClient({
      nihoWebOrigin: config.nihoWebOrigin,
      serviceIdToken,
      fetch,
    });
    statuses = await client.getStatuses([check.nihoUserId]);
  } catch {
    return true;
  }
  if (!statuses.ok) return true;
  const result = statuses.statuses[0];
  if (!result || result.nihoUserId !== check.nihoUserId) return true;
  const applied = await store.applyStatus({
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
    return (await store.prepareCheck({ kind, sessionToken, nowUtc: new Date().toISOString() })).kind !== "session-ended";
  }
  return true;
}
