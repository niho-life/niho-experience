import type { ExternalReservationObservation } from "@niho-experience/experience-store";
import { boundedObject, channelFailure, channelJson, exactKeys, internalContext } from "@/lib/experience/channel-runtime";
import { reservationObservation, reservationWindowTerminal } from "@/lib/experience/reservation-read-contract";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = await internalContext(request);
  if (context instanceof Response) return context;
  const body = await boundedObject(request);
  if (body instanceof Response) return body;
  if (!exactKeys(body, ["receiptId", "readId", "leaseToken", "pageNumber", "observations"],
    ["previousReceiptId", "sourceCursor", "nextSourceCursor", "snapshotToken", "terminal"])
    || typeof body.receiptId !== "string" || typeof body.readId !== "string"
    || typeof body.leaseToken !== "string" || body.leaseToken.length < 1 || body.leaseToken.length > 100
    || !Number.isInteger(body.pageNumber) || (body.pageNumber as number) < 0 || (body.pageNumber as number) > 4095
    || (body.previousReceiptId !== undefined && typeof body.previousReceiptId !== "string")
    || (body.sourceCursor !== undefined && (typeof body.sourceCursor !== "string" || body.sourceCursor.length < 1 || body.sourceCursor.length > 512))
    || (body.nextSourceCursor !== undefined && (typeof body.nextSourceCursor !== "string" || body.nextSourceCursor.length < 1 || body.nextSourceCursor.length > 512))
    || (body.snapshotToken !== undefined && (typeof body.snapshotToken !== "string" || body.snapshotToken.length < 1 || body.snapshotToken.length > 256))
    || !Array.isArray(body.observations) || body.observations.length > 32) return channelJson({ error: "invalid_input" }, 400);
  const observations = body.observations.map(reservationObservation);
  const terminal = body.terminal === undefined ? undefined : reservationWindowTerminal(body.terminal);
  if (observations.some((item) => item === null) || terminal === null
    || (terminal?.status === "FAILED" && observations.length !== 0)
    || (terminal?.status === "COMPLETE" && !(terminal.allPagesRead && terminal.allStatusesIncluded && terminal.coverageComplete))
    || (body.pageNumber === 0 && body.sourceCursor !== undefined)
    || ((body.pageNumber as number) > 0 && body.sourceCursor === undefined)
    || (terminal === undefined && body.nextSourceCursor === undefined)
    || (terminal === undefined && body.pageNumber === 4095)
    || (terminal !== undefined && body.nextSourceCursor !== undefined)) return channelJson({ error: "invalid_input" }, 400);
  try {
    return channelJson(await context.runtime.submitReservationWindowPage(context.worker, (await params).id, {
      receiptId: body.receiptId,
      readId: body.readId,
      leaseToken: body.leaseToken,
      pageNumber: body.pageNumber as number,
      ...(body.previousReceiptId === undefined ? {} : { previousReceiptId: body.previousReceiptId as string }),
      ...(body.sourceCursor === undefined ? {} : { sourceCursor: body.sourceCursor as string }),
      ...(body.nextSourceCursor === undefined ? {} : { nextSourceCursor: body.nextSourceCursor as string }),
      ...(body.snapshotToken === undefined ? {} : { snapshotToken: body.snapshotToken as string }),
      observations: observations as ExternalReservationObservation[],
      ...(terminal === undefined ? {} : { terminal }),
    }));
  } catch (error) {
    return channelFailure(error);
  }
}
