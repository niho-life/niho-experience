import { guestReviewRepository } from "@/lib/experience/store-server";
import { fromThisSite } from "@/lib/experience/public-http";
import { publicEmpty, publicJson, readReviewBody, reviewToken, reviewWritingEnabled, reviewError } from "@/lib/experience/guest-review-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Read-only: email link scanners never consume an invitation. */
export async function POST(request: Request): Promise<Response> {
  if (!reviewWritingEnabled()) return publicEmpty(404);
  if (!fromThisSite(request)) return publicEmpty(403);
  const reviews = guestReviewRepository();
  if (!reviews) return reviewError("UNAVAILABLE");
  const body = await readReviewBody(request);
  if (!body.ok) return body.response;
  if (Object.keys(body.value).some((key) => key !== "token")) return reviewError("INPUT_INVALID");
  const token = reviewToken(body.value.token);
  if (!token) return publicEmpty(404);
  try {
    const invitation = await reviews.openInvitation(token);
    return invitation ? publicJson(200, { invitation }) : publicEmpty(404);
  } catch {
    return reviewError("UNAVAILABLE");
  }
}
