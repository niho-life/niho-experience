import type { PublicPerson } from "@niho-experience/experience-store";

/**
 * 街の人 → 体験 (#585): the people each experience is met through, by experience slug, in the order people are shown on 街の人.
 * A person's `experienceSlugs` already holds their own provider's experiences and the products linked to them, so this is
 * just the same relation seen from the experience.
 */
export function peopleByExperience(people: readonly PublicPerson[]): ReadonlyMap<string, readonly PublicPerson[]> {
  const map = new Map<string, PublicPerson[]>();
  for (const person of people) for (const slug of person.experienceSlugs) map.set(slug, [...(map.get(slug) ?? []), person]);
  return map;
}
