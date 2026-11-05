type ProviderMediaDescription = {
  readonly id: string;
  readonly placement: "PROVIDER_PHOTO" | "BUSINESS_LOGO";
  readonly altText: string;
  readonly altTextJa: string;
  readonly publicCredit: string | null;
};

/** Keep the current asset selection; only reapply this editor's changed descriptions to surviving assets. */
export function reapplyProviderMediaEdits<T extends ProviderMediaDescription>(
  latest: readonly T[],
  draft: readonly ProviderMediaDescription[],
  baseline: readonly ProviderMediaDescription[],
): T[] {
  const key = (item: ProviderMediaDescription) => `${item.placement}:${item.id}`;
  const originals = new Map(baseline.map((item) => [key(item), item]));
  const edits = new Map(draft.map((item) => [key(item), item]));
  return latest.map((item) => {
    const before = originals.get(key(item));
    const edit = edits.get(key(item));
    if (!before || !edit) return item;
    return {
      ...item,
      ...(edit.altText !== before.altText ? { altText: edit.altText } : {}),
      ...(edit.altTextJa !== before.altTextJa ? { altTextJa: edit.altTextJa } : {}),
      ...(edit.publicCredit !== before.publicCredit ? { publicCredit: edit.publicCredit } : {}),
    };
  });
}
