import { ASK_HOST_TOPICS, askHostInputProblem, type AskHostTopic } from "@niho-experience/api-client";
import { StoreNotFoundError, StoreRateLimitedError, StoreValidationError } from "@niho-experience/experience-store";
import { config } from "@/lib/config";
import { guestQuestionRepository } from "@/lib/experience/store-server";
import { clientRequestKey, fromThisSite, guestQuestionEmpty, guestQuestionError, guestQuestionJson, readGuestQuestionBody } from "@/lib/experience/guest-questions-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * "Ask the host" (#105) from the experience page, kept in the experience DB (docs/guest-questions.md).
 * The same contract the AskHost form already reads (packages/api-client/src/journey.ts): 201
 * `{ accepted: true }`, 404 without a body, or the closed `{ error }` body. Nothing in it is logged.
 */
export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }): Promise<Response> {
  if (!config.guestQuestionsEnabled) return guestQuestionEmpty(404);
  const { slug } = await params;
  if (slug.length < 1 || slug.length > 160) return guestQuestionEmpty(404);
  if (!fromThisSite(request)) return guestQuestionEmpty(403);
  const questions = guestQuestionRepository();
  if (!questions) return guestQuestionError("SEND_FAILED");
  const body = await readGuestQuestionBody(request);
  if (!body.ok) return body.response;

  const { topic, message, guestName, guestEmail } = body.value;
  const key = clientRequestKey(body.value.clientRequestKey);
  if (!key) return guestQuestionError("INPUT_INVALID", { field: "clientRequestKey" });
  if (typeof topic !== "string" || !ASK_HOST_TOPICS.includes(topic as AskHostTopic)) return guestQuestionError("INPUT_INVALID", { field: "topic" });
  if (typeof message !== "string") return guestQuestionError("INPUT_INVALID", { field: "message" });
  if (typeof guestName !== "string") return guestQuestionError("INPUT_INVALID", { field: "guestName" });
  if (typeof guestEmail !== "string") return guestQuestionError("INPUT_INVALID", { field: "guestEmail" });
  const problem = askHostInputProblem({ topic: topic as AskHostTopic, message, guestName, guestEmail });
  if (problem) return guestQuestionError("INPUT_INVALID", { field: problem });

  try {
    await questions.submitQuestion({ productSlug: slug, topic: topic as AskHostTopic, message, guestName, guestEmail, clientRequestKey: key });
    return guestQuestionJson(201, { accepted: true });
  } catch (error) {
    if (error instanceof StoreNotFoundError) return guestQuestionEmpty(404);
    if (error instanceof StoreRateLimitedError) return guestQuestionError("RATE_LIMITED", { retryAfterSeconds: error.retryAfterSeconds });
    if (error instanceof StoreValidationError) return guestQuestionError("VALIDATION_ERROR");
    return guestQuestionError("SEND_FAILED");
  }
}
