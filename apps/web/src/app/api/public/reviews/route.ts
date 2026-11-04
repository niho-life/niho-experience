import { StoreConflictError, StoreNotFoundError, StoreValidationError } from "@niho-experience/experience-store";
import { guestReviewRepository } from "@/lib/experience/store-server";
import { fromThisSite } from "@/lib/experience/public-http";
import { publicEmpty, publicJson, readReviewBody, reviewError, reviewSubmission, reviewToken, reviewWritingEnabled } from "@/lib/experience/guest-review-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One review for the booking in the invitation, published as the store accepts it. */
export async function POST(request: Request): Promise<Response> {
  if (!reviewWritingEnabled()) return publicEmpty(404);
  if (!fromThisSite(request)) return publicEmpty(403);
  const reviews = guestReviewRepository();
  if (!reviews) return reviewError("UNAVAILABLE");
  const body = await readReviewBody(request);
  if (!body.ok) return body.response;
  const token = reviewToken(body.value.token);
  if (!token) return publicEmpty(404);
  const submission = reviewSubmission(body.value);
  if (!submission) return reviewError("INPUT_INVALID");
  try {
    await reviews.submitReview(token, submission);
    return publicJson(201, { accepted: true });
  } catch (error) {
    if (error instanceof StoreNotFoundError) return publicEmpty(404);
    if (error instanceof StoreConflictError) return reviewError("LINK_USED");
    if (error instanceof StoreValidationError) return reviewError("INPUT_INVALID");
    return reviewError("UNAVAILABLE");
  }
}
