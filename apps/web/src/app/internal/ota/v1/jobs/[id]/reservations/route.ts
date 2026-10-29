import type { ExternalReservationObservation, ReservationReadBatchStatus } from "@niho-experience/experience-store";
import { boundedObject, channelFailure, channelJson, exactKeys, internalContext } from "@/lib/experience/channel-runtime";

export const runtime = "nodejs";

function observation(value: unknown): ExternalReservationObservation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (!exactKeys(item, ["externalReservationId", "externalProductId", "sourceStartAtUtc", "sourceEndAtUtc", "status", "seats"],
    ["externalOptionId", "sourceUpdatedAtUtc", "sourceRevision"])) return null;
  if (typeof item.externalReservationId !== "string" || item.externalReservationId.length < 1 || item.externalReservationId.length > 256
    || typeof item.externalProductId !== "string" || item.externalProductId.length < 1 || item.externalProductId.length > 256
    || (item.externalOptionId !== undefined && (typeof item.externalOptionId !== "string" || item.externalOptionId.length > 256))
    || typeof item.sourceStartAtUtc !== "string" || typeof item.sourceEndAtUtc !== "string"
    || (item.status !== "PENDING" && item.status !== "CONFIRMED" && item.status !== "CANCELLED")
    || !Number.isInteger(item.seats) || (item.seats as number) < 1 || (item.seats as number) > 1000
    || (item.sourceUpdatedAtUtc !== undefined && typeof item.sourceUpdatedAtUtc !== "string")
    || (item.sourceRevision !== undefined && (typeof item.sourceRevision !== "string" || item.sourceRevision.length < 1 || item.sourceRevision.length > 256))) return null;
  return item as unknown as ExternalReservationObservation;
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = await internalContext(request);
  if (context instanceof Response) return context;
  const body = await boundedObject(request);
  if (body instanceof Response) return body;
  if (!exactKeys(body, ["receiptId", "readId", "leaseToken", "batchStatus", "observations"])
    || typeof body.receiptId !== "string" || typeof body.readId !== "string"
    || typeof body.leaseToken !== "string" || body.leaseToken.length < 1 || body.leaseToken.length > 100
    || (body.batchStatus !== "COMPLETE" && body.batchStatus !== "PARTIAL" && body.batchStatus !== "FAILED")
    || !Array.isArray(body.observations) || body.observations.length > 32) return channelJson({ error: "invalid_input" }, 400);
  const observations = body.observations.map(observation);
  if (observations.some((item) => item === null) || (body.batchStatus === "FAILED" && observations.length !== 0)) {
    return channelJson({ error: "invalid_input" }, 400);
  }
  try {
    const result = await context.runtime.submitReservationRead(context.worker, (await params).id, {
      receiptId: body.receiptId,
      readId: body.readId,
      leaseToken: body.leaseToken,
      batchStatus: body.batchStatus as ReservationReadBatchStatus,
      observations: observations as ExternalReservationObservation[],
    });
    return channelJson(result);
  } catch (error) {
    return channelFailure(error);
  }
}
