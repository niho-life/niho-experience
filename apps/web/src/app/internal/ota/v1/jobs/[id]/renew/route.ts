import { boundedObject, channelFailure, channelJson, exactKeys, internalContext } from "@/lib/experience/channel-runtime";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = await internalContext(request);
  if (context instanceof Response) return context;
  const body = await boundedObject(request);
  if (body instanceof Response) return body;
  if (!exactKeys(body, ["leaseToken"]) || typeof body.leaseToken !== "string" || body.leaseToken.length > 100) return channelJson({ error: "invalid_input" }, 400);
  try {
    return channelJson(await context.runtime.renew(context.worker, (await params).id, body.leaseToken));
  } catch (error) {
    return channelFailure(error);
  }
}
