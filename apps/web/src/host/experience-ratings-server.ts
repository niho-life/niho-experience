import "server-only";
import type { HostActor } from "@niho-experience/experience-store";
import { hostCalendarSettings } from "@/lib/experience/store-server";
import type { HostProvider } from "@/lib/host/providers";
import { isHostMock } from "@/lib/host/server";
import { loadGuestReviews } from "./guest-reviews-server";
import { experienceRating } from "./reviews";

/*
 * 体験の一覧's ★ in http mode (provider operations on, #108): each experience's published reviews kept in the experience
 * DB, as レビュー reads them for the OWNER, by the public path NIHO's page and this site's product share (the page's
 * slug; docs/guest-booking.md「体験の登録と切替」). The list renders without them: closed, anyone else, or a failed
 * read is no ★ at all.
 */

/** One experience's ★: the product レビュー filters by, the average and how many. */
export interface ExperienceRatingLink {
  productId: string;
  average: string;
  count: number;
}

/** By the experience's slug. */
export type ExperienceRatings = Record<string, ExperienceRatingLink>;

function ownerActor(providerId: string, nihoUserId: string): HostActor {
  return { providerId, nihoUserId, calendarRoleCeiling: "OWNER" };
}

export async function loadExperienceRatings(provider: Pick<HostProvider, "id" | "memberRole">, nihoUserId: string): Promise<ExperienceRatings> {
  if (isHostMock()) return {};
  const settings = hostCalendarSettings();
  if (!settings) return {};
  const reviews = await loadGuestReviews(provider, nihoUserId);
  if (reviews.status !== "live" || reviews.experiences.length === 0) return {};
  let slugs: Readonly<Record<string, string>>;
  try {
    slugs = await settings.productSlugs(ownerActor(provider.id, nihoUserId));
  } catch (error) {
    console.error("Experience ratings read failed", { error: error instanceof Error ? error.name : typeof error });
    return {};
  }
  const ratings: ExperienceRatings = {};
  for (const { id } of reviews.experiences) {
    const rating = experienceRating(reviews.reviews, id);
    const slug = slugs[id];
    if (rating && slug) ratings[slug] = { productId: id, ...rating };
  }
  return ratings;
}
