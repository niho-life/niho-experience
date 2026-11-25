import type { NihoAccountRowStatus } from "@/components/host/HostNihoAccountRow";
import { config } from "@/lib/config";
import { nihoIdentityOutcomeOrNull, type NihoIdentityOutcome } from "./niho-identity";
import { loadNihoIdentityStatus } from "./niho-identity-server";
import type { HostSession } from "./session";

export interface NihoAccountRowData {
  providerId: string | null;
  status: NihoAccountRowStatus;
  outcome: NihoIdentityOutcome | null;
}

/** The NIHO account row's data (Epic #591): with the NIHO account login on, for a host account's own session only. */
export async function nihoAccount(session: HostSession, providerId: string | null, query: Readonly<Record<string, string | string[] | undefined>>): Promise<NihoAccountRowData | null> {
  if (session.kind !== "experience" || !config.hostNihoLoginEnabled) return null;
  return { providerId, status: await loadNihoIdentityStatus(session.hostAccountId), outcome: nihoIdentityOutcomeOrNull(Array.isArray(query.niho) ? query.niho[0] : query.niho) };
}
