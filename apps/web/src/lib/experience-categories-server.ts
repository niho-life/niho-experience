import "server-only";
import type { ExperienceCategoryId, ExperienceClassification } from "@niho-experience/experience-domain";
import { productClassificationRepository } from "./experience/store-server";

/**
 * Slug → category of every published product, for the list's category row (#658). Read apart from the publication and the same
 * for both languages. Null when the classification cannot be read (no store, or a failed read): the list then has no category
 * row and no category filter, but still shows every experience.
 */
export async function loadCategoryBySlug(): Promise<ReadonlyMap<string, ExperienceCategoryId> | null> {
  try {
    const repository = productClassificationRepository();
    if (!repository) return null;
    const classifications = await repository.listPublic();
    const bySlug = new Map<string, ExperienceCategoryId>();
    for (const [slug, classification] of classifications) if (classification.category) bySlug.set(slug, classification.category);
    return bySlug;
  } catch {
    return null;
  }
}

/** One product's public classification (category and area), or null when it has none or cannot be read: the detail page then shows neither. */
export async function loadClassificationOf(slug: string): Promise<ExperienceClassification | null> {
  try {
    return (await productClassificationRepository()?.listPublic())?.get(slug) ?? null;
  } catch {
    return null;
  }
}
