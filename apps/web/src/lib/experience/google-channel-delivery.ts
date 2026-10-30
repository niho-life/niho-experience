import "server-only";
import type { Pool } from "pg";
import {
  GoogleChannelDeliveryRepository,
  StoreConflictError,
  type ChannelRuntime,
  type GoogleChannelDeliveryRecord,
  type GoogleChannelDeliverySecretSnapshot,
  type GoogleChannelSelectedMetadata,
  type WorkerIdentity,
} from "@niho-experience/experience-store";
import {
  applyGoogleManagedBlock,
  GOOGLE_SCOPES,
  GoogleCalendarError,
  inspectGoogleManagedBlock,
  refreshGoogleToken,
  type GoogleManagedBlockMetadata,
  type GoogleManagedBlockTarget,
} from "@niho-experience/google-calendar";
import { googleRuntimeConfig } from "./google-connection";
import { openGoogleRefreshToken, sealGoogleRefreshToken } from "./google-token-crypto";

export type GoogleChannelDeliveryOperation = "dispatch" | "reconcile" | "observe";

function target(snapshot: GoogleChannelDeliverySecretSnapshot): GoogleManagedBlockTarget {
  const value = snapshot.storedTarget;
  return {
    providerOpaqueId: value.providerId,
    listingOpaqueId: value.listingId,
    occurrenceOpaqueId: value.occurrenceId,
    mappingVersion: value.mappingVersion,
    desiredVersion: value.desiredVersion,
    sourceStartAtUtc: value.sourceStartAtUtc,
    sourceEndAtUtc: value.sourceEndAtUtc,
    desiredState: value.desiredState,
  };
}

function selected(value: GoogleManagedBlockMetadata): GoogleChannelSelectedMetadata {
  return {
    eventId: value.eventId, etag: value.etag, bindingHash: value.bindingHash,
    mappingVersion: value.mappingVersion, desiredVersion: value.desiredVersion,
    startAtUtc: value.startAtUtc, endAtUtc: value.endAtUtc,
    desiredState: value.desiredState, transparency: value.transparency,
  };
}

function staticGoogleReason(error: unknown): "GOOGLE_REVOKED" | "GOOGLE_UNAVAILABLE" | "INVALID_RESPONSE" {
  if (error instanceof GoogleCalendarError) {
    if (error.reason === "REVOKED") return "GOOGLE_REVOKED";
    if (error.reason === "INVALID_RESPONSE") return "INVALID_RESPONSE";
  }
  return "GOOGLE_UNAVAILABLE";
}

/** Server-only executor. Returned DTO never includes calendar IDs, tokens, or Google metadata. */
export async function executeGoogleChannelDelivery(
  pool: Pool,
  runtime: ChannelRuntime,
  worker: WorkerIdentity,
  jobId: string,
  leaseToken: string,
  operation: GoogleChannelDeliveryOperation,
  injected?: {
    readonly runtimeConfig?: typeof googleRuntimeConfig;
    readonly openRefreshToken?: typeof openGoogleRefreshToken;
    readonly sealRefreshToken?: typeof sealGoogleRefreshToken;
    readonly refreshToken?: typeof refreshGoogleToken;
  },
): Promise<GoogleChannelDeliveryRecord> {
  const repository = new GoogleChannelDeliveryRepository(pool, runtime);
  const snapshot = operation === "dispatch"
    ? await repository.prepareDispatch(worker, jobId, leaseToken)
    : operation === "reconcile" ? await repository.prepareReconcile(worker, jobId, leaseToken)
      : await repository.prepareObservation(worker, jobId, leaseToken);
  if (!snapshot) throw new StoreConflictError("No Google delivery journal exists for this intent.");
  if (operation === "dispatch" && !snapshot.canDispatch) return snapshot.record;

  const runtimeConfig = injected?.runtimeConfig ?? googleRuntimeConfig;
  const openRefreshToken = injected?.openRefreshToken ?? openGoogleRefreshToken;
  const sealRefreshToken = injected?.sealRefreshToken ?? sealGoogleRefreshToken;
  const refreshToken = injected?.refreshToken ?? refreshGoogleToken;
  const configured = runtimeConfig();
  const saveResult = (result: Parameters<GoogleChannelDeliveryRepository["saveResult"]>[6]) => repository.saveResult(
    worker, jobId, leaseToken, snapshot.record.deliveryId, snapshot.operationNonce, operation, result,
  );
  if (!configured || !GOOGLE_SCOPES.every((scope) => snapshot.grantedScopes.includes(scope))) {
    return saveResult({
      phase: operation === "reconcile" ? "UNCERTAIN" : "STOPPED", reason: "INVALID_RESPONSE",
    });
  }
  const assertCurrent = () => repository.assertCurrent(
    worker, jobId, leaseToken, snapshot.record.deliveryId, snapshot.operationNonce, operation,
  );
  await assertCurrent();

  let accessToken: string;
  try {
    const openedRefreshToken = openRefreshToken(configured.key, snapshot.context.providerId, snapshot.encryptedRefreshToken);
    const token = await refreshToken(configured.google, openedRefreshToken, snapshot.grantedScopes);
    accessToken = token.accessToken;
    await assertCurrent();
    if (token.refreshToken) {
      const saved = await repository.saveRotatedRefreshToken(
        snapshot.context.providerId,
        snapshot.connectionGeneration,
        sealRefreshToken(configured.key, snapshot.context.providerId, token.refreshToken),
      );
      if (!saved) throw new StoreConflictError("Google connection changed during token rotation.");
    }
    await assertCurrent();
  } catch (error) {
    if (error instanceof StoreConflictError) throw error;
    return saveResult({ phase: operation === "reconcile" ? "UNCERTAIN" : "STOPPED", reason: staticGoogleReason(error) });
  }

  try {
    if (operation === "reconcile" || operation === "observe") {
      const result = await inspectGoogleManagedBlock(
        configured.google, accessToken, snapshot.calendarId, target(snapshot), assertCurrent,
      );
      if (result.code === "GOOGLE_VERIFIED") {
        return saveResult({
          phase: "GOOGLE_VERIFIED", metadata: selected(result.google), changed: false, writeAcknowledged: false,
        });
      }
      return saveResult({
        phase: "NOT_MATCHED", reason: result.reason, changed: false, writeAcknowledged: false,
      });
    }

    const result = await applyGoogleManagedBlock(
      configured.google, accessToken, snapshot.calendarId, target(snapshot), assertCurrent,
    );
    if (result.code === "GOOGLE_VERIFIED") {
      return saveResult({
        phase: "GOOGLE_VERIFIED", metadata: selected(result.google), changed: result.changed,
        writeAcknowledged: result.writeAcknowledged,
      });
    }
    if (result.code === "WRITE_UNCERTAIN") {
      return saveResult({
        phase: "UNCERTAIN", reason: "WRITE_UNCERTAIN", changed: null, writeAcknowledged: result.writeAcknowledged,
      });
    }
    return saveResult({
      phase: "NOT_MATCHED", reason: result.code, changed: false, writeAcknowledged: false,
    });
  } catch (error) {
    if (error instanceof StoreConflictError) throw error;
    return saveResult({ phase: operation === "observe" ? "STOPPED" : "UNCERTAIN", reason: staticGoogleReason(error) });
  }
}
