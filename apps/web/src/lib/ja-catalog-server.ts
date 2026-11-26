import "server-only";
import { cache } from "react";
import { listSitePublicExperiences } from "./experience/site-publications";
import { productClassificationRepository } from "./experience/store-server";
import { jaCardOf, type JaCard } from "./ja-catalog";

/** The Japanese list's cards: published, saleable products with Japanese text, each with its classification (read apart from the publication). */
export const loadJaCards = cache(async (): Promise<readonly JaCard[]> => {
  const [catalog, classifications] = await Promise.all([
    listSitePublicExperiences("ja"),
    // A failed read of the classification leaves the list without categories, never without experiences.
    productClassificationRepository()?.listPublic().catch(() => new Map()) ?? new Map(),
  ]);
  return catalog.experiences.flatMap((item) => {
    const card = jaCardOf(item, classifications.get(item.publication.slug), item.memberProfiles ?? []);
    return card ? [card] : [];
  });
});
