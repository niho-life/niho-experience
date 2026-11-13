/**
 * The provider's public name as a page's language shows it (#587). The English pages show the English public name when the
 * provider has one and the Japanese name otherwise; the Japanese pages always show the Japanese name. Null when the provider has
 * no public name (the caller then falls back as it did before: the seller's display name).
 */
export function providerNameFor(publication: { readonly providerPublicName?: string | null; readonly providerPublicNameEn?: string | null }, locale: "en" | "ja"): string | null {
  const japanese = publication.providerPublicName ?? null;
  if (locale === "ja") return japanese;
  return publication.providerPublicNameEn?.trim() || japanese;
}
