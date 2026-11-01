import { canonicalExternalReservationGuest, type ExternalReservationObservation, type ReservationWindowTerminalEvidence } from "@niho-experience/experience-store";
import { exactKeys } from "./channel-runtime";

/** The guest details a reader may add (#194): only the store's allowlist, checked the store's way. */
function validGuest(value: unknown, seats: unknown): boolean {
  if (value === undefined) return true;
  if (!Number.isInteger(seats)) return false;
  try {
    canonicalExternalReservationGuest(value, seats as number);
    return true;
  } catch {
    return false;
  }
}

export function reservationObservation(value: unknown): ExternalReservationObservation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (!exactKeys(item, ["externalReservationId", "externalProductId", "sourceStartAtUtc", "sourceEndAtUtc", "status", "seats"],
    ["externalOptionId", "sourceUpdatedAtUtc", "sourceRevision", "guest"])) return null;
  if (typeof item.externalReservationId !== "string" || item.externalReservationId.length < 1 || item.externalReservationId.length > 256
    || typeof item.externalProductId !== "string" || item.externalProductId.length < 1 || item.externalProductId.length > 256
    || (item.externalOptionId !== undefined && (typeof item.externalOptionId !== "string" || item.externalOptionId.length > 256))
    || typeof item.sourceStartAtUtc !== "string" || typeof item.sourceEndAtUtc !== "string"
    || (item.status !== "PENDING" && item.status !== "CONFIRMED" && item.status !== "CANCELLED")
    || !Number.isInteger(item.seats) || (item.seats as number) < 1 || (item.seats as number) > 1000
    || (item.sourceUpdatedAtUtc !== undefined && typeof item.sourceUpdatedAtUtc !== "string")
    || (item.sourceRevision !== undefined && (typeof item.sourceRevision !== "string" || item.sourceRevision.length < 1 || item.sourceRevision.length > 256))
    || !validGuest(item.guest, item.seats)) return null;
  return item as unknown as ExternalReservationObservation;
}

export function reservationWindowTerminal(value: unknown): ReservationWindowTerminalEvidence | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (!exactKeys(item, ["status", "completedAtUtc", "allPagesRead", "allStatusesIncluded", "coverageComplete"])
    || (item.status !== "COMPLETE" && item.status !== "PARTIAL" && item.status !== "FAILED")
    || typeof item.completedAtUtc !== "string" || typeof item.allPagesRead !== "boolean"
    || typeof item.allStatusesIncluded !== "boolean" || typeof item.coverageComplete !== "boolean") return null;
  return item as unknown as ReservationWindowTerminalEvidence;
}
