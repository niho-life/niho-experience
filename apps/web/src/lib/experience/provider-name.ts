type HostNameSource = {
  readonly providerPublicName?: string | null;
  readonly providerPublicNameEn?: string | null;
  readonly providerRegisteredName?: string | null;
};

const clean = (value: string | null | undefined): string | null => value?.trim() || null;

/**
 * The host's name as a page's language shows it (#587, #691). The single place that decides it.
 * The public name (registered by the NIHO office) comes first; when the host has none, the name the host uses on its seller
 * registration (`providerRegisteredName`, already public in the "Sold by" line). The English pages show the English public name
 * when there is one, then the Japanese name; the Japanese pages never show the English one. Never the legal seller name
 * (`sellerDisplayName`): null when there is no name at all, and the caller then leaves the host name out.
 */
export function providerNameFor(publication: HostNameSource, locale: "en" | "ja"): string | null {
  const japanese = clean(publication.providerPublicName);
  const registered = clean(publication.providerRegisteredName);
  if (locale === "ja") return japanese ?? registered;
  return clean(publication.providerPublicNameEn) ?? japanese ?? registered;
}

/**
 * The host's kind: the public profile's kind when the host has a public profile (a managed host sells through another company's
 * seller, so the seller's kind is not its kind); otherwise the seller disclosure's kind. Null when unknown.
 */
export function providerKindFor(
  publication: { readonly providerPublicName?: string | null; readonly providerKind?: "PERSON" | "BUSINESS" | null },
  sellerKind?: "PERSON" | "BUSINESS" | null,
): "PERSON" | "BUSINESS" | null {
  return publication.providerPublicName ? publication.providerKind ?? null : sellerKind ?? null;
}
