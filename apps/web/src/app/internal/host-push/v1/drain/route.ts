import { hostPushDrainResponse } from "@/lib/host/push/job";

export const dynamic = "force-dynamic";

/** Cloud Scheduler's trigger for the host push job. Only POST is exported; other methods get 405. */
export async function POST(request: Request): Promise<Response> {
  return hostPushDrainResponse(request);
}
