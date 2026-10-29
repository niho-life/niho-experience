import type { ExternalReservationObservation, ReservationReadBatchStatus } from "@niho-experience/experience-store";
import { boundedObject, channelFailure, channelJson, exactKeys, internalContext } from "@/lib/experience/channel-runtime";
import { reservationObservation } from "@/lib/experience/reservation-read-contract";

export const runtime = "nodejs";

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
  const observations = body.observations.map(reservationObservation);
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
