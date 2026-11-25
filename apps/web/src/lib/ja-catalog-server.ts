import "server-only";
import { cache } from "react";
import { listSitePublicExperiences } from "./experience/site-publications";
import { productClassificationRepository } from "./experience/store-server";
import { jaCardOf, type JaCard } from "./ja-catalog";
import { loadPeople } from "./ja-people";
import { peopleByExperience } from "./ja-people-links";

/** The Japanese list's cards: published, saleable products with Japanese text, each with its classification (read apart from the publication). */
export const loadJaCards = cache(async (): Promise<readonly JaCard[]> => {
  const [catalog, classifications, people] = await Promise.all([
    listSitePublicExperiences("ja"),
    // A failed read of the classification leaves the list without categories, never without experiences.
    productClassificationRepository()?.listPublic().catch(() => new Map()) ?? new Map(),
    // 街の人 (#585): who each experience is met through; a failed read leaves the card as it was.
    loadPeople(),
  ]);
  const guides = peopleByExperience(people);
  return catalog.experiences.flatMap((item) => {
    const card = jaCardOf(item, classifications.get(item.publication.slug), guides.get(item.publication.slug) ?? []);
    return card ? [card] : [];
  });
});
