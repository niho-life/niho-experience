import { StoreConflictError, StoreNotFoundError, StoreValidationError } from "@niho-experience/experience-store";
import { REPLY_PAGE_MESSAGE_MAX_LENGTH } from "@/lib/guest-reply";
import { config } from "@/lib/config";
import { guestQuestionRepository } from "@/lib/experience/store-server";
import { clientRequestKey, fromThisSite, guestQuestionEmpty, guestQuestionError, guestQuestionJson, readGuestQuestionBody, replyToken } from "@/lib/experience/guest-questions-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The guest's answer from the reply page (#105): `{ token, message, clientRequestKey }`. 201
 * `{ accepted: true }`, also for the same answer sent again; 404 for a link that is unknown or
 * expired; 409 LINK_USED once the link has answered something else.
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
  const key = clientRequestKey(body.value.clientRequestKey);
  if (!key) return guestQuestionError("INPUT_INVALID", { field: "clientRequestKey" });
  const message = body.value.message;
  if (typeof message !== "string" || message.trim() === "" || message.trim().length > REPLY_PAGE_MESSAGE_MAX_LENGTH) return guestQuestionError("INPUT_INVALID", { field: "message" });
  try {
    await questions.submitGuestReply(token, { message, clientRequestKey: key });
    return guestQuestionJson(201, { accepted: true });
  } catch (error) {
    if (error instanceof StoreNotFoundError) return guestQuestionEmpty(404);
    if (error instanceof StoreConflictError) return guestQuestionError("LINK_USED");
    if (error instanceof StoreValidationError) return guestQuestionError("INPUT_INVALID", { field: "message" });
    return guestQuestionError("SEND_FAILED");
  }
}
