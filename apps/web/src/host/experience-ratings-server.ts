import "server-only";
import { StoreAccessDeniedError, type HostActor } from "@niho-experience/experience-store";
import { guestReviewRatings } from "@/lib/experience/store-server";
import type { HostProvider } from "@/lib/host/providers";
import { isHostMock } from "@/lib/host/server";

/*
 * 体験の一覧's ★ in http mode (provider operations on, #108): each experience's shown reviews kept in the experience DB,
 * all of them counted and averaged there for the OWNER (レビュー's list reads only a page), by the public path NIHO's
 * page and this site's product share (the page's slug; docs/guest-booking.md「体験の登録と切替」). The list renders
 * without them: closed, anyone else, or a failed read is no ★ at all.
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
  if (isHostMock() || provider.memberRole !== "OWNER") return {};
  const store = guestReviewRatings();
  if (!store) return {};
  try {
    const rows = await store.byProduct(ownerActor(provider.id, nihoUserId));
    return Object.fromEntries(rows.map((row) => [row.slug, { productId: row.productId, average: row.average, count: row.count }]));
  } catch (error) {
    // The experience DB does not count this account as the OWNER: no ★, as レビュー shows them nothing either.
    if (!(error instanceof StoreAccessDeniedError)) console.error("Experience ratings read failed", { error: error instanceof Error ? error.name : typeof error });
    return {};
  }
}
