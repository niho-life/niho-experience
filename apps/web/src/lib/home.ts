/** The home page highlights up to six experiences, in an optional editor-picked order. */
export const HOME_EXPERIENCE_LIMIT = 6;
export const HOME_EXPERIENCE_PICK_SLUGS: readonly string[] = [];

export function pickHomeExperiences<T extends { slug: string }>(items: readonly T[], picks: readonly string[] = HOME_EXPERIENCE_PICK_SLUGS, limit = HOME_EXPERIENCE_LIMIT): T[] {
  const bySlug = new Map(items.map((item) => [item.slug, item] as const));
  const chosen: T[] = [];
  for (const slug of picks) {
    const item = bySlug.get(slug);
    if (item && !chosen.includes(item)) chosen.push(item);
  }
  for (const item of items) {
    if (chosen.length >= limit) break;
    if (!chosen.includes(item)) chosen.push(item);
  }
  return chosen.slice(0, limit);
}
