import { SAFE_UTM_VALUE } from "./booking-attribution";

/*
 * 提供者経由の予約リンク (#531 v0): the public page of one published experience with the 流入の印 (the existing booking UTM,
 * docs/growth/funnel-measurement.md「提供者経由のリンク」). The mark is `utm_source=provider` and a `utm_medium` for where the
 * link is placed. It carries no name, address, phone or ID of anyone: the experience's slug already says whose it is, so a
 * per-provider count is the confirmed bookings of that provider's slugs with `utm_source=provider`.
 */

export const PROVIDER_LINK_SOURCE = "provider";

/** Where the host puts the link. The words are the host's; the value is the `utm_medium` a booking is counted under. */
export const PROVIDER_LINK_PLACEMENTS = [
  { value: "referral", label: "自分のサイトやメール" },
  { value: "social", label: "SNS" },
  { value: "qr", label: "店頭のQR・印刷物" },
] as const;
export type ProviderLinkPlacement = (typeof PROVIDER_LINK_PLACEMENTS)[number]["value"];

/** The public page's address with the mark, or null for something that is not a link we would hand out. */
/** `japaneseOnly` (#59): a product with no English page lives at `/ja/experiences/{slug}`, so the link points there. */
export function providerBookingLink(input: { readonly origin: string; readonly slug: string; readonly placement: ProviderLinkPlacement; readonly japaneseOnly?: boolean }): string | null {
  if (!PROVIDER_LINK_PLACEMENTS.some((item) => item.value === input.placement)) return null;
  if (!SAFE_UTM_VALUE.test(PROVIDER_LINK_SOURCE) || !SAFE_UTM_VALUE.test(input.placement)) return null;
  if (typeof input.slug !== "string" || input.slug === "" || input.slug.length > 160) return null;
  let base: URL;
  try { base = new URL(input.origin); } catch { return null; }
  if (base.protocol !== "https:" && !(base.protocol === "http:" && (base.hostname === "localhost" || base.hostname === "127.0.0.1"))) return null;
  const url = new URL(`${input.japaneseOnly === true ? "/ja" : ""}/experiences/${encodeURIComponent(input.slug)}`, base.origin);
  url.searchParams.set("utm_source", PROVIDER_LINK_SOURCE);
  url.searchParams.set("utm_medium", input.placement);
  return url.href;
}

/**
 * The link points at the live public page, so it is offered only for a published product whose saved draft is the live
 * version. While a change (for example a new slug) waits for the publication conditions the live page keeps its old
 * address and the draft's slug would not reach it (the same rule as the host's own "公開ページを見る").
 */
export function providerBookingLinkAvailable(product: { readonly status: string; readonly publicationNeedsUpdate: boolean }): boolean {
  return product.status === "PUBLISHED" && !product.publicationNeedsUpdate;
}
