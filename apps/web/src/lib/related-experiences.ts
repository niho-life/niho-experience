/**
 * Other experiences to suggest on a detail page (#146): never the current one, those sharing more of its catalogue themes
 * first (v1.2 `themes`; without themes, the catalogue order), at most `limit`.
 */
export function pickRelatedExperiences<T extends { slug: string; themes?: readonly string[] }>(currentSlug: string, listed: readonly T[], limit = 3): T[] {
  const themes = new Set(listed.find((item) => item.slug === currentSlug)?.themes ?? []);
  const shared = (item: T) => (item.themes ?? []).filter((theme) => themes.has(theme)).length;
  return listed
    .filter((item) => item.slug !== currentSlug)
    .map((item, index) => ({ item, index, score: shared(item) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, Math.max(0, limit))
    .map((entry) => entry.item);
}
