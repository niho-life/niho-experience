/**
 * The items whose slug is not in `nativeSlugs`. The English list reads the same published products twice in the live mode (the
 * legacy summaries come from the publications too, and the native cards from the sale catalog), so a slug the site owns is dropped
 * from the legacy side and the native card stays (#643).
 */
export function withoutNativeSlugs<T extends { readonly slug: string }>(items: readonly T[], nativeSlugs: Iterable<string>): T[] {
  const owned = new Set(nativeSlugs);
  return items.filter((item) => !owned.has(item.slug));
}
