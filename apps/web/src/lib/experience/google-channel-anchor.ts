import "server-only";
import type { Pool } from "pg";
import {
  GoogleChannelAnchorRepository,
  StoreConflictError,
  type GoogleChannelAnchorInput,
  type GoogleChannelAnchorRecord,
} from "@niho-experience/experience-store";
import type { HostActor } from "@niho-experience/experience-store";
import {
  GOOGLE_SCOPES,
  GoogleCalendarError,
  initializeGoogleManagedBlock,
  inspectGoogleManagedBlock,
  refreshGoogleToken,
} from "@niho-experience/google-calendar";
import { config } from "@/lib/config";
import { googleRuntimeConfig } from "./google-connection";
import { openGoogleRefreshToken, sealGoogleRefreshToken } from "./google-token-crypto";

export const googleChannelAnchorEnabled = () => config.apiMode === "http"
  && config.hostConsoleEnabled
  && process.env.EXPERIENCE_AIRBNB_GOOGLE_SETUP_ENABLED === "true";

function googleReason(error: unknown): "GOOGLE_REVOKED" | "GOOGLE_UNAVAILABLE" | "INVALID_RESPONSE" {
  if (error instanceof GoogleCalendarError) {
    if (error.reason === "REVOKED") return "GOOGLE_REVOKED";
    if (error.reason === "INVALID_RESPONSE") return "INVALID_RESPONSE";
  }
  return "GOOGLE_UNAVAILABLE";
}

/** Selects only owner-safe command status; Google control metadata stays server-side. */
export function googleChannelAnchorDto(value: GoogleChannelAnchorRecord) {
  return {
    commandId: value.commandId,
    listingId: value.listingId,
    occurrenceId: value.occurrenceId,
    state: value.state,
    ...(value.reason ? { reason: value.reason } : {}),
  };
}

export async function executeGoogleChannelAnchor(
  pool: Pool,
  actor: HostActor,
  input: GoogleChannelAnchorInput,
  injected?: {
    readonly runtimeConfig?: typeof googleRuntimeConfig;
    readonly refreshToken?: typeof refreshGoogleToken;
    readonly initialize?: typeof initializeGoogleManagedBlock;
    readonly inspect?: typeof inspectGoogleManagedBlock;
  },
): Promise<GoogleChannelAnchorRecord> {
  const repository = new GoogleChannelAnchorRepository(pool);
  const ownerResult = async (pending: Promise<GoogleChannelAnchorRecord>) => {
    const value = await pending;
    await repository.assertCurrentOwnerAccess(actor);
    return value;
  };
  if (input.operation === "inspect") {
    const cancelled = await repository.cancelPreparing(actor, input);
    if (cancelled) return ownerResult(Promise.resolve(cancelled));
  }
  const snapshot = await repository.prepare(actor, input);
  if (!snapshot.canPerform) return ownerResult(Promise.resolve(snapshot.record));

  const runtimeConfig = injected?.runtimeConfig ?? googleRuntimeConfig;
  const configured = runtimeConfig();
  if (!configured || !GOOGLE_SCOPES.every((scope) => snapshot.grantedScopes.includes(scope))) {
    return ownerResult(input.operation === "inspect"
      ? repository.saveUncertain(snapshot, "CONFIG_UNAVAILABLE")
      : repository.failBeforeInitialize(snapshot, "CONFIG_UNAVAILABLE"));
  }

  let accessToken: string;
  try {
    const opened = openGoogleRefreshToken(configured.key, snapshot.providerId, snapshot.encryptedRefreshToken);
    const token = await (injected?.refreshToken ?? refreshGoogleToken)(configured.google, opened, snapshot.grantedScopes);
    accessToken = token.accessToken;
    if (token.refreshToken) {
      const saved = await repository.saveRotatedRefreshToken(
        snapshot,
        sealGoogleRefreshToken(configured.key, snapshot.providerId, token.refreshToken),
      );
      if (!saved) throw new StoreConflictError("Google connection changed during token rotation.");
    }
  } catch (error) {
    const reason = error instanceof StoreConflictError ? "AUTHORITY_CHANGED" : googleReason(error);
    return ownerResult(input.operation === "inspect"
      ? repository.saveUncertain(snapshot, reason)
      : repository.failBeforeInitialize(snapshot, reason));
  }

  if (input.operation === "initialize") {
    try { await repository.markInitializing(snapshot); }
    catch {
      return ownerResult(repository.failBeforeInitialize(snapshot, "AUTHORITY_CHANGED"));
    }
  }

  const target = {
    providerOpaqueId: snapshot.providerId,
    listingOpaqueId: snapshot.record.listingId,
    occurrenceOpaqueId: snapshot.record.occurrenceId,
    mappingVersion: snapshot.mappingVersion,
    desiredVersion: snapshot.desiredVersion,
    sourceStartAtUtc: snapshot.sourceStartAtUtc,
    sourceEndAtUtc: snapshot.sourceEndAtUtc,
    desiredState: snapshot.desiredState,
  } as const;
  const assertCurrent = () => repository.assertCurrent(snapshot);

  if (input.operation === "inspect") {
    try {
      const result = await (injected?.inspect ?? inspectGoogleManagedBlock)(
        configured.google, accessToken, snapshot.calendarId, target, assertCurrent,
      );
      if (result.code !== "GOOGLE_VERIFIED") {
        return ownerResult(repository.saveUncertain(snapshot, result.reason));
      }
      let saved: GoogleChannelAnchorRecord;
      try {
        saved = await repository.saveVerified(snapshot, result.google, false, false);
      } catch {
        return ownerResult(repository.saveUncertain(snapshot, "AUTHORITY_CHANGED"));
      }
      return ownerResult(Promise.resolve(saved));
    } catch (error) {
      return ownerResult(repository.saveUncertain(snapshot, googleReason(error)));
    }
  }

  try {
    const result = await (injected?.initialize ?? initializeGoogleManagedBlock)(
      configured.google, accessToken, snapshot.calendarId, target, assertCurrent,
    );
    if (result.code === "WRITE_UNCERTAIN") {
      return ownerResult(repository.saveUncertain(snapshot, "WRITE_UNCERTAIN"));
    }
    if (result.code !== "GOOGLE_VERIFIED") {
      return ownerResult(repository.saveStopped(snapshot, result.code));
    }
    let saved: GoogleChannelAnchorRecord;
    try {
      saved = await repository.saveVerified(
        snapshot, result.google, result.changed, result.writeAcknowledged,
      );
    } catch {
      return ownerResult(repository.saveUncertain(snapshot, "AUTHORITY_CHANGED"));
    }
    return ownerResult(Promise.resolve(saved));
  } catch (error) {
    return ownerResult(repository.saveUncertain(snapshot, googleReason(error)));
  }
}
