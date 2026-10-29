import { boundedObject, channelEmpty, channelFailure, channelJson, exactKeys, internalContext } from "@/lib/experience/channel-runtime";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const context = await internalContext(request);
  if (context instanceof Response) return context;
  const body = await boundedObject(request);
  if (body instanceof Response) return body;
  if (!exactKeys(body, [])) return channelJson({ error: "invalid_input" }, 400);
  try {
    await context.runtime.consumeCalendarOutbox(50, context.worker);
    const job = await context.runtime.claim(context.worker);
    return job ? channelJson({ job }) : channelEmpty();
  } catch (error) {
    return channelFailure(error);
  }
}
