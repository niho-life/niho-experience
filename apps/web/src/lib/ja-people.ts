import "server-only";
import type { PublicPerson } from "@niho-experience/experience-store";
import { peopleListingRepository } from "@/lib/experience/store-server";
import { listSitePublicExperiences, type SitePublicExperience } from "@/lib/experience/site-publications";

/*
 * 街の人 (#564, docs/people.md) for the Japanese site: who is listed and, for a person's page, the experiences they
 * offer that have a Japanese manuscript. The store decides who is public (a listed person with a public profile and a
 * rights-confirmed photo); a failed or missing read shows an empty page, never an error that names a person.
 */

/** Everyone on 街の人, in the Admin's order. */
export async function loadPeople(): Promise<readonly PublicPerson[]> {
  try { return await peopleListingRepository()?.listPublic() ?? []; } catch { return []; }
}

export type PersonPageData = { readonly person: PublicPerson; readonly experiences: readonly SitePublicExperience[] };

/** One person and the experiences they offer now (Japanese manuscript, on sale), newest first. null: not listed (or not shown). */
export async function loadPerson(slug: string): Promise<PersonPageData | null> {
  let person: PublicPerson | null = null;
  try { person = await peopleListingRepository()?.getPublicBySlug(slug) ?? null; } catch { person = null; }
  if (!person) return null;
  let experiences: readonly SitePublicExperience[] = [];
  if (person.experienceSlugs.length > 0) {
    try {
      const catalog = await listSitePublicExperiences("ja");
      const order = new Map(person.experienceSlugs.map((experienceSlug, index) => [experienceSlug, index] as const));
      experiences = catalog.experiences
        .filter((item) => order.has(item.publication.slug) && item.saleTerms !== null)
        .sort((a, b) => (order.get(a.publication.slug) ?? 0) - (order.get(b.publication.slug) ?? 0));
    } catch { experiences = []; }
  }
  return { person, experiences };
}
