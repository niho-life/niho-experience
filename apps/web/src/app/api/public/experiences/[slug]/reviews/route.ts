import { REVIEW_LIMITS, type ExperienceReviewsResponse, type PublicErrorResponse } from "@niho-experience/api-client";
import { config } from "@/lib/config";
import { publicEmpty, publicJson } from "@/lib/experience/public-http";
import { guestReviewRepository } from "@/lib/experience/store-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LIMIT = /^[1-9][0-9]{0,2}$/;

/**
 * 予約者のレビュー of an experience (#104), from the experience DB in the shape the experience page already
 * reads (ExperienceReviewsResponse, packages/api-client/src/journey.ts): the published reviews, the latest
 * first, and the summary of all of them. `?limit=` keeps the first 1-50. An experience that is not published
 * here is 404 without a body.
 */
export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }): Promise<Response> {
  if (!config.guestReviewsEnabled) return publicEmpty(404);
  const { slug } = await params;
  if (slug.length < 1 || slug.length > 160) return publicEmpty(404);
  const limitParam = new URL(request.url).searchParams.get("limit");
  const limit = limitParam === null ? undefined : LIMIT.test(limitParam) ? Number(limitParam) : Number.NaN;
  if (limit !== undefined && !(limit >= 1 && limit <= REVIEW_LIMITS.listMaxItems)) {
    return publicJson(400, { error: { code: "VALIDATION_ERROR", message: "limit is invalid." } } satisfies PublicErrorResponse);
  }
  const reviews = guestReviewRepository();
  if (!reviews) return publicEmpty(503);
  try {
    const body = await reviews.listPublishedReviews(slug, limit === undefined ? {} : { limit });
    return body === null ? publicEmpty(404) : publicJson(200, body satisfies ExperienceReviewsResponse);
  } catch (error) {
    console.error("Experience guest reviews failed", { error: error instanceof Error ? error.name : typeof error });
    return publicEmpty(503);
  }
}
