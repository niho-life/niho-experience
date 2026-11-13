import type { SitePublicExperience } from "@/lib/experience/site-publications";

/*
 * The small experience tile on the Japanese site's 街の人 and 読みもの pages (#564, #154): a photo, the title, how long it
 * takes and what it costs. The price is the one a guest would pay now: the lowest adult price among the current sale
 * terms' offers (the manuscript's base price can differ), with 〜 when the offers differ. The same rule as the catalogue's
 * card (lib/experience/site-card-model.ts), in Japanese. Without sale terms it falls back to the manuscript's price.
 */

export interface JapaneseTileFacts {
  readonly slug: string;
  readonly title: string;
  readonly cover: { readonly url: string; readonly alt: string } | null;
  readonly duration: string | null;
  readonly price: string;
}

const yen = (amount: number) => `${new Intl.NumberFormat("ja-JP").format(amount)}円`;
const hoursAndMinutes = (minutes: number) => (minutes % 60 === 0 ? `${minutes / 60}時間` : minutes > 60 ? `${Math.floor(minutes / 60)}時間${minutes % 60}分` : `${minutes}分`);

export function japaneseTileFacts(item: SitePublicExperience): JapaneseTileFacts {
  const { publication, saleTerms } = item;
  const offers = saleTerms?.offers ?? [];
  const prices = offers.map((offer) => offer.pricing.adultPriceYen).filter((value): value is number => typeof value === "number");
  const lowest = prices.length > 0 ? Math.min(...prices) : publication.unitAmount;
  const durations = [...new Set(offers.map((offer) => offer.durationMinutes).filter((value): value is number => typeof value === "number"))];
  const cover = publication.photos[0];
  return {
    slug: publication.slug,
    title: publication.japanese?.title ?? publication.publicTitle,
    cover: cover ? { url: cover.src, alt: cover.altJa } : null,
    duration: durations.length === 1 ? hoursAndMinutes(durations[0]!) : null,
    price: `1名 ${yen(lowest)}${new Set(prices).size > 1 ? "〜" : ""}`,
  };
}
