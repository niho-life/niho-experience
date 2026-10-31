import { googleBusySyncResponse } from "@/lib/experience/google-calendar-jobs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Cloud Scheduler's trigger for the Google busy re-check (#238). Only POST is exported; other methods get 405. */
export async function POST(request: Request): Promise<Response> {
  return googleBusySyncResponse(request);
}
