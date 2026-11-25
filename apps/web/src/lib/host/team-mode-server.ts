import { config } from "@/lib/config";
import type { HostTeamMode } from "@/components/host/HostOperatingTeamPanel";
import { providerOperationsEnabled } from "./provider-operations-server";
import type { HostSession } from "./session";

/** How the member panel works for this session: the Experience host accounts' own, NIHO's legacy one, or off. */
export function hostTeamMode(session: Pick<HostSession, "kind">): HostTeamMode {
  return config.hostTeamEnabled && session.kind === "experience" ? "native" : providerOperationsEnabled() ? "legacy" : "off";
}
