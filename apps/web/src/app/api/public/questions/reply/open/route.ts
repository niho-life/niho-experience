import { config } from "@/lib/config";
import { guestQuestionRepository } from "@/lib/experience/store-server";
import { fromThisSite, guestQuestionEmpty, guestQuestionError, guestQuestionJson, readGuestQuestionBody, replyToken } from "@/lib/experience/guest-questions-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The guest's reply page (#105) opens its link: `{ token }` in the body (never in the URL), and the
 * conversation back (the guest's words and the host's English). 404 when the link is unknown,
 * expired or already used; the page says so without telling which.
 */
export async function POST(request: Request): Promise<Response> {
  if (!config.guestQuestionsEnabled) return guestQuestionEmpty(404);
  if (!fromThisSite(request)) return guestQuestionEmpty(403);
  const questions = guestQuestionRepository();
  if (!questions) return guestQuestionError("SEND_FAILED");
  const body = await readGuestQuestionBody(request);
  if (!body.ok) return body.response;
  const token = replyToken(body.value.token);
  if (!token) return guestQuestionEmpty(404);
  try {
    const link = await questions.openReplyLink(token);
    return link ? guestQuestionJson(200, { link }) : guestQuestionEmpty(404);
  } catch {
    return guestQuestionError("SEND_FAILED");
  }
}
