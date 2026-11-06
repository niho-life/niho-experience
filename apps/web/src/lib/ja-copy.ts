import { createStaticCopyV1, type StaticCopyAccessorV1, type StaticCopyValuesV1 } from "@niho/experience-presentation/v1";

/**
 * The presentation package's `booking.showMoreDates` view passes the English nouns "date" / "dates" as `{noun}` (the view has no
 * locale). Japanese has no plural, so both become 日程, instead of leaving an English word in a Japanese sentence.
 */
const JAPANESE_NOUNS: Readonly<Record<string, string>> = { date: "日程", dates: "日程" };

/**
 * The copy accessor of every Japanese page, from the local release or from NIHO's: the same values `createStaticCopyV1`
 * validates, with the noun fix above. Small on purpose: the client-side locale context imports it, so it must not pull in a dictionary.
 */
export function createJapaneseCopy(values: StaticCopyValuesV1): StaticCopyAccessorV1 {
  const base = createStaticCopyV1(values);
  const text: StaticCopyAccessorV1["text"] = (key, interpolation) => base.text(key, key === "booking.showMoreDates" && interpolation && typeof interpolation.noun === "string"
    ? { ...interpolation, noun: JAPANESE_NOUNS[interpolation.noun] ?? interpolation.noun }
    : interpolation);
  return Object.freeze({ values: base.values, rich: base.rich, text });
}
