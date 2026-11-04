import { guestMailFeedbackResponse } from "@/lib/guest-mail-feedback";

export const dynamic = "force-dynamic";

/** NIHO's authenticated post-delivery feedback callback. */
export async function POST(request: Request): Promise<Response> {
  return guestMailFeedbackResponse(request);
}
