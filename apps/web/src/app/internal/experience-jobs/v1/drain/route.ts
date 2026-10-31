import { experienceJobsDrainResponse } from "@/lib/experience-jobs/job";

export const dynamic = "force-dynamic";

/** Cloud Scheduler's trigger for the experience mail job (#285 slice 5). Only POST is exported; other methods get 405. */
export async function POST(request: Request): Promise<Response> {
  return experienceJobsDrainResponse(request);
}
