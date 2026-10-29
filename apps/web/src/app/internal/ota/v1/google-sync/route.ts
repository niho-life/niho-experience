import { boundedObject, channelFailure, channelJson, exactKeys, internalContext } from "@/lib/experience/channel-runtime";
import { syncOneDueResourceGoogle } from "@/lib/experience/resource-google";
import { experiencePool } from "@/lib/experience/store-server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const context = await internalContext(request);
  if (context instanceof Response) return context;
  const body = await boundedObject(request);
  if (body instanceof Response) return body;
  if (!exactKeys(body, [])) return channelJson({ error: "invalid_input" }, 400);
  const pool = experiencePool();
  if (!pool) return channelJson({ error: "runtime_unavailable" }, 503);
  try { return channelJson(await syncOneDueResourceGoogle(pool, context.worker)); }
  catch (error) { return channelFailure(error); }
}
