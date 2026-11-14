import { StoreNotFoundError, StoreRateLimitedError, StoreValidationError } from "@niho-experience/experience-store";
import { config } from "@/lib/config";
import { personMessageRepository } from "@/lib/experience/store-server";
import { fromThisSite } from "@/lib/experience/public-http";
import { clientRequestKey, guestQuestionEmpty, guestQuestionError, guestQuestionJson, readGuestQuestionBody } from "@/lib/experience/guest-questions-http";
import { personMessageProblem } from "@/lib/person-message";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A message to a person on 街の人 (#589) from their page on the Japanese site, kept in the experience DB as a thread of the
 * person's provider (docs/guest-questions.md「人物ページから」). 201 `{ accepted: true }`, 404 without a body (the flag is off,
 * or the person is not shown: no hint which), or the closed `{ error }` body of the questions' routes. Nothing in it is logged.
 */
export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }): Promise<Response> {
  // Closed while the people pages are off (#612): there is no page to send it from.
  if (!config.personMessagesEnabled || !config.japaneseSiteEnabled || !config.peoplePagesEnabled) return guestQuestionEmpty(404);
  const { slug } = await params;
  if (slug.length < 1 || slug.length > 60) return guestQuestionEmpty(404);
  if (!fromThisSite(request)) return guestQuestionEmpty(403);
  const people = personMessageRepository();
  if (!people) return guestQuestionError("SEND_FAILED");
  const body = await readGuestQuestionBody(request);
  if (!body.ok) return body.response;

  const { message, guestName, guestEmail } = body.value;
  const key = clientRequestKey(body.value.clientRequestKey);
  if (!key) return guestQuestionError("INPUT_INVALID", { field: "clientRequestKey" });
  if (typeof message !== "string") return guestQuestionError("INPUT_INVALID", { field: "message" });
  if (typeof guestName !== "string") return guestQuestionError("INPUT_INVALID", { field: "guestName" });
  if (typeof guestEmail !== "string") return guestQuestionError("INPUT_INVALID", { field: "guestEmail" });
  const problem = personMessageProblem({ message, guestName, guestEmail });
  if (problem) return guestQuestionError("INPUT_INVALID", { field: problem });

  try {
    await people.submitPersonMessage({ personSlug: slug, message, guestName, guestEmail, language: "JA", clientRequestKey: key });
    return guestQuestionJson(201, { accepted: true });
  } catch (error) {
    if (error instanceof StoreNotFoundError) return guestQuestionEmpty(404);
    if (error instanceof StoreRateLimitedError) return guestQuestionError("RATE_LIMITED", { retryAfterSeconds: error.retryAfterSeconds });
    if (error instanceof StoreValidationError) return guestQuestionError("VALIDATION_ERROR");
    return guestQuestionError("SEND_FAILED");
  }
}
