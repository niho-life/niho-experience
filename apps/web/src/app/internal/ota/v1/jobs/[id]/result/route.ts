import type { ChannelDesiredState, ChannelOutcome, ChannelTarget, GoogleAirbnbProof } from "@niho-experience/experience-store";
import { boundedObject, channelFailure, channelJson, exactKeys, internalContext } from "@/lib/experience/channel-runtime";

export const runtime = "nodejs";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function target(value: unknown): ChannelTarget | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (!exactKeys(item, ["site", "externalAccountId", "externalProductId", "timeZone", "adapter", "adapterVersion", "connectionMode"], ["externalOptionId"])) return null;
  if (typeof item.site !== "string" || item.site.length < 1 || item.site.length > 80
    || typeof item.externalAccountId !== "string" || item.externalAccountId.length < 1 || item.externalAccountId.length > 256
    || typeof item.externalProductId !== "string" || item.externalProductId.length < 1 || item.externalProductId.length > 256
    || (item.externalOptionId !== undefined && (typeof item.externalOptionId !== "string" || item.externalOptionId.length > 256))
    || item.timeZone !== "Asia/Tokyo" || typeof item.adapter !== "string" || item.adapter.length < 1 || item.adapter.length > 120
    || typeof item.adapterVersion !== "string" || item.adapterVersion.length < 1 || item.adapterVersion.length > 80
    || typeof item.connectionMode !== "string" || !["BROWSER", "GOOGLE", "API"].includes(item.connectionMode)) return null;
  return { site: item.site, externalAccountId: item.externalAccountId, externalProductId: item.externalProductId,
    ...(item.externalOptionId === undefined ? {} : { externalOptionId: item.externalOptionId as string }), timeZone: "Asia/Tokyo",
    adapter: item.adapter, adapterVersion: item.adapterVersion, connectionMode: item.connectionMode as ChannelTarget["connectionMode"] };
}

function googleAirbnbProof(value: unknown): GoogleAirbnbProof | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (!exactKeys(item, ["deliveryId", "evidence", "partySize"]) || typeof item.deliveryId !== "string" || !UUID_V4.test(item.deliveryId)
    || item.evidence !== "EXACT_SLOT_V1" || item.partySize !== 1) return null;
  return { deliveryId: item.deliveryId, evidence: "EXACT_SLOT_V1", partySize: 1 };
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = await internalContext(request);
  if (context instanceof Response) return context;
  const body = await boundedObject(request);
  if (body instanceof Response) return body;
  if (!exactKeys(body, ["resultId", "leaseToken", "outcome", "stopped", "target"],
    ["occurrenceId", "sourceStartAtUtc", "sourceEndAtUtc", "observedState", "observedBookable", "observedManuallyBlocked", "observedAtUtc",
      "googleAirbnbProof", "reservationReadId", "reservationReceiptId"])) {
    return channelJson({ error: "invalid_input" }, 400);
  }
  const parsedTarget = target(body.target);
  const parsedGoogleAirbnbProof = body.googleAirbnbProof === undefined ? undefined : googleAirbnbProof(body.googleAirbnbProof);
  const outcomes = ["VERIFIED", "RESERVATION_VERIFIED", "AUTH_REQUIRED", "NEEDS_REVIEW", "UNKNOWN_AFTER_SAVE", "RETRY_WAIT", "SUPERSEDED"];
  const verifiedFieldsPresent = body.outcome !== "VERIFIED" || (body.occurrenceId !== undefined
    && body.sourceStartAtUtc !== undefined && body.sourceEndAtUtc !== undefined && body.observedState !== undefined
    && body.observedBookable !== undefined && body.observedAtUtc !== undefined
    && ((body.observedManuallyBlocked !== undefined && body.googleAirbnbProof === undefined)
      || (body.observedManuallyBlocked === undefined && parsedGoogleAirbnbProof !== undefined)));
  const googleRetryFieldsPresent = body.outcome !== "RETRY_WAIT" || body.googleAirbnbProof === undefined
    || (body.occurrenceId !== undefined && body.sourceStartAtUtc !== undefined && body.sourceEndAtUtc !== undefined
      && body.observedState !== undefined && body.observedBookable !== undefined && body.observedAtUtc !== undefined
      && body.observedManuallyBlocked === undefined && parsedGoogleAirbnbProof !== undefined);
  const reservationFieldsValid = body.outcome !== "RESERVATION_VERIFIED"
    ? body.reservationReadId === undefined && body.reservationReceiptId === undefined
    : typeof body.reservationReadId === "string" && typeof body.reservationReceiptId === "string"
      && body.occurrenceId === undefined && body.sourceStartAtUtc === undefined && body.sourceEndAtUtc === undefined
      && body.observedState === undefined && body.observedBookable === undefined
      && body.observedManuallyBlocked === undefined && body.observedAtUtc === undefined
      && body.googleAirbnbProof === undefined;
  if (typeof body.resultId !== "string" || typeof body.leaseToken !== "string" || body.leaseToken.length > 100
    || typeof body.outcome !== "string" || !outcomes.includes(body.outcome) || typeof body.stopped !== "boolean" || !parsedTarget
    || (body.googleAirbnbProof !== undefined && parsedGoogleAirbnbProof === null)
    || (body.outcome !== "VERIFIED" && body.outcome !== "RETRY_WAIT" && body.googleAirbnbProof !== undefined)
    || !verifiedFieldsPresent || !googleRetryFieldsPresent || !reservationFieldsValid
    || (body.occurrenceId !== undefined && (typeof body.occurrenceId !== "string" || body.occurrenceId.length < 1 || body.occurrenceId.length > 256))
    || (body.sourceStartAtUtc !== undefined && typeof body.sourceStartAtUtc !== "string")
    || (body.sourceEndAtUtc !== undefined && typeof body.sourceEndAtUtc !== "string")
    || (body.observedState !== undefined && body.observedState !== "OPEN" && body.observedState !== "CLOSED")
    || (body.observedBookable !== undefined && typeof body.observedBookable !== "boolean")
    || (body.observedManuallyBlocked !== undefined && typeof body.observedManuallyBlocked !== "boolean")
    || (body.observedAtUtc !== undefined && typeof body.observedAtUtc !== "string")) return channelJson({ error: "invalid_input" }, 400);
  try {
    const result = await context.runtime.submitResult(context.worker, (await params).id, {
      resultId: body.resultId, leaseToken: body.leaseToken, outcome: body.outcome as ChannelOutcome, stopped: body.stopped,
      target: parsedTarget, ...(body.observedState === undefined ? {} : { observedState: body.observedState as ChannelDesiredState }),
      ...(body.occurrenceId === undefined ? {} : { occurrenceId: body.occurrenceId as string }),
      ...(body.sourceStartAtUtc === undefined ? {} : { sourceStartAtUtc: body.sourceStartAtUtc as string }),
      ...(body.sourceEndAtUtc === undefined ? {} : { sourceEndAtUtc: body.sourceEndAtUtc as string }),
      ...(body.observedBookable === undefined ? {} : { observedBookable: body.observedBookable as boolean }),
      ...(body.observedManuallyBlocked === undefined ? {} : { observedManuallyBlocked: body.observedManuallyBlocked as boolean }),
      ...(body.observedAtUtc === undefined ? {} : { observedAtUtc: body.observedAtUtc as string }),
      ...(parsedGoogleAirbnbProof == null ? {} : { googleAirbnbProof: parsedGoogleAirbnbProof }),
      ...(body.reservationReadId === undefined ? {} : { reservationReadId: body.reservationReadId as string }),
      ...(body.reservationReceiptId === undefined ? {} : { reservationReceiptId: body.reservationReceiptId as string }),
    });
    // This acknowledges the durable receipt, independently of a current-state
    // verification. The worker must not retry a recorded stale result as new work.
    return channelJson({ acceptedAsCurrent: result.acceptedAsCurrent, repeated: result.repeated });
  } catch (error) {
    return channelFailure(error);
  }
}
