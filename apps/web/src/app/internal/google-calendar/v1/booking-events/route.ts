import { googleBookingEventsResponse } from "@/lib/experience/google-calendar-jobs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Cloud Scheduler's trigger for writing confirmed bookings to the booking calendars (#238). Only POST is exported; other methods get 405. */
export async function POST(request: Request): Promise<Response> {
  return googleBookingEventsResponse(request);
}
