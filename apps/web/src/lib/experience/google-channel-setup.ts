import "server-only";
import type { Pool } from "pg";
import {
  GoogleChannelSetupRepository,
  StoreConflictError,
  type GoogleChannelSetupRecord,
} from "@niho-experience/experience-store";
import {
  createAirbnbOutputCalendar,
  GOOGLE_SCOPES,
  GoogleCalendarError,
  refreshGoogleToken,
} from "@niho-experience/google-calendar";
import type { HostActor } from "@niho-experience/experience-store";
import { config } from "@/lib/config";
import { googleRuntimeConfig } from "./google-connection";
import { openGoogleRefreshToken, sealGoogleRefreshToken } from "./google-token-crypto";

export const googleChannelSetupEnabled = () => config.apiMode === "http"
  && config.hostConsoleEnabled
  && process.env.EXPERIENCE_AIRBNB_GOOGLE_SETUP_ENABLED === "true";

function reason(error: unknown): "GOOGLE_REVOKED" | "GOOGLE_UNAVAILABLE" | "INVALID_RESPONSE" {
  if (error instanceof GoogleCalendarError) {
    if (error.reason === "REVOKED") return "GOOGLE_REVOKED";
    if (error.reason === "INVALID_RESPONSE") return "INVALID_RESPONSE";
  }
  return "GOOGLE_UNAVAILABLE";
}

/** The selected DTO contains no nonce, calendar ID, token, scope, or Google response field. */
export function googleChannelSetupDto(value: GoogleChannelSetupRecord) {
  return {
    commandId: value.commandId,
    listingId: value.listingId,
    state: value.state,
    calendarName: value.calendarName,
    ...(value.reason ? { reason: value.reason } : {}),
  };
}

/** Creates at most one calendar after the durable CREATING fence. */
export async function executeGoogleChannelSetup(
  pool: Pool,
  actor: HostActor,
  input: { listingId: string; expectedMappingVersion: number; commandId: string; operation?: "cancel_preparing" },
  injected?: {
    readonly runtimeConfig?: typeof googleRuntimeConfig;
    readonly refreshToken?: typeof refreshGoogleToken;
  },
): Promise<GoogleChannelSetupRecord> {
  const repository = new GoogleChannelSetupRepository(pool);
  const ownerResult = async (pending: Promise<GoogleChannelSetupRecord>) => {
    const record = await pending;
    await repository.assertCurrentOwnerAccess(actor);
    return record;
  };
  if (input.operation === "cancel_preparing") return ownerResult(repository.cancelPreparing(actor, input));
  const snapshot = await repository.prepare(actor, input);
  if (!snapshot.canCreate) return snapshot.record;
  const runtimeConfig = injected?.runtimeConfig ?? googleRuntimeConfig;
  const refreshToken = injected?.refreshToken ?? refreshGoogleToken;
  const configured = runtimeConfig();
  if (!configured || !GOOGLE_SCOPES.every((scope) => snapshot.grantedScopes.includes(scope))) {
    return ownerResult(repository.failBeforeCreate(snapshot, "CONFIG_UNAVAILABLE"));
  }

  let accessToken: string;
  try {
    const opened = openGoogleRefreshToken(configured.key, snapshot.providerId, snapshot.encryptedRefreshToken);
    const token = await refreshToken(configured.google, opened, snapshot.grantedScopes);
    accessToken = token.accessToken;
    if (token.refreshToken) {
      const saved = await repository.saveRotatedRefreshToken(
        snapshot,
        sealGoogleRefreshToken(configured.key, snapshot.providerId, token.refreshToken),
      );
      if (!saved) throw new StoreConflictError("Google connection changed during token rotation.");
    }
  } catch (error) {
    return ownerResult(repository.failBeforeCreate(snapshot, error instanceof StoreConflictError ? "AUTHORITY_CHANGED" : reason(error)));
  }

  try {
    await repository.markCreating(snapshot);
  } catch {
    return ownerResult(repository.failBeforeCreate(snapshot, "AUTHORITY_CHANGED"));
  }

  let calendarId: string;
  try {
    calendarId = await createAirbnbOutputCalendar(
      configured.google, accessToken, snapshot.record.calendarName,
    );
  } catch (error) {
    return ownerResult(repository.markUncertain(snapshot, reason(error)));
  }

  try {
    return await repository.finish(snapshot, calendarId);
  } catch {
    return ownerResult(repository.markUncertain(snapshot, "STORE_FAILED"));
  }
}
