import "server-only";
import type { Pool } from "pg";
import { HostNotificationOutbox, HostPushSubscriptions } from "@niho-experience/experience-store";
import { config } from "@/lib/config";
import { experiencePool } from "@/lib/experience/store-server";
import { internalServiceJson, serviceIdentityFailure, verifyGoogleServiceIdentity, type GoogleTokenVerifier } from "@/lib/google-service-identity";
import { drainHostNotifications, hostNotificationAllowed, type HostNotificationDrainCounts } from "./outbox";
import { hostPushDeps } from "./server";

export interface HostPushJobSettings {
  readonly enabled: boolean;
  readonly audience: string;
  readonly serviceAccountEmail: string;
}

export interface HostPushJobDependencies {
  readonly settings?: HostPushJobSettings;
  readonly verifier?: GoogleTokenVerifier;
  readonly pool?: () => Pool | null;
  readonly drain?: (pool: Pool) => Promise<HostNotificationDrainCounts>;
}

function drainWithPool(pool: Pool): Promise<HostNotificationDrainCounts> {
  return drainHostNotifications({
    outbox: new HostNotificationOutbox(pool),
    pushDeps: () => hostPushDeps(new HostPushSubscriptions(pool)),
    allowed: hostNotificationAllowed,
    now: Date.now,
    log: (counts) => {
      if (counts.claimed > 0) console.info(`[host-push] drain ${JSON.stringify(counts)}`);
    },
  });
}

/**
 * POST /internal/host-push/v1/drain (#177 P2): Cloud Scheduler runs one drain with its service
 * account's Google ID token. 404 while the job is not configured, 401 for any other caller, 503
 * when Google's keys or the experience DB cannot be reached. The answer is the counts only.
 */
export async function hostPushDrainResponse(request: Pick<Request, "headers">, dependencies: HostPushJobDependencies = {}): Promise<Response> {
  const settings = dependencies.settings ?? {
    enabled: config.hostPushJobEnabled,
    audience: config.hostPushJobAudience,
    serviceAccountEmail: config.hostPushJobServiceAccountEmail,
  };
  if (!settings.enabled) return internalServiceJson({ error: "not_found" }, 404);
  const identity = await verifyGoogleServiceIdentity(request, settings, dependencies.verifier);
  if (!identity.ok) return serviceIdentityFailure(identity.kind);
  const pool = (dependencies.pool ?? experiencePool)();
  if (!pool) return internalServiceJson({ error: "unavailable" }, 503);
  try {
    return internalServiceJson(await (dependencies.drain ?? drainWithPool)(pool));
  } catch (error) {
    // The error's name only: a database message can quote row values.
    console.error(`[host-push] drain failed: ${error instanceof Error ? error.name : "unknown error"}`);
    return internalServiceJson({ error: "unavailable" }, 503);
  }
}
