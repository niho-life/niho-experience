import {
  boundedObject,
  channelFailure,
  channelJson,
  exactKeys,
  googleChannelDeliveryEnabled,
  internalContext,
} from "@/lib/experience/channel-runtime";
import { executeGoogleChannelDelivery } from "@/lib/experience/google-channel-delivery";
import { experiencePool } from "@/lib/experience/store-server";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!googleChannelDeliveryEnabled()) return channelJson({ error: "not_found" }, 404);
  const context = await internalContext(request);
  if (context instanceof Response) return context;
  const body = await boundedObject(request);
  if (body instanceof Response) return body;
  if (!exactKeys(body, ["leaseToken", "operation"])
    || typeof body.leaseToken !== "string" || body.leaseToken.length < 1 || body.leaseToken.length > 100
    || (body.operation !== "dispatch" && body.operation !== "reconcile")) {
    return channelJson({ error: "invalid_input" }, 400);
  }
  const pool = experiencePool();
  if (!pool) return channelJson({ error: "runtime_unavailable" }, 503);
  try {
    const result = await executeGoogleChannelDelivery(
      pool, context.runtime, context.worker, (await params).id, body.leaseToken, body.operation,
    );
    return channelJson({ deliveryId: result.deliveryId, phase: result.phase, ...(result.reason ? { reason: result.reason } : {}), airbnb: "UNVERIFIED" });
  } catch (error) {
    return channelFailure(error);
  }
}
