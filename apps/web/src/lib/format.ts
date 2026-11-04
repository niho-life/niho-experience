const TZ = "Asia/Tokyo";
const intlLocale = (locale: "en" | "ja") => locale === "ja" ? "ja-JP" : "en-US";
export const formatYen = (amountYen: number, locale: "en" | "ja" = "en") => new Intl.NumberFormat(intlLocale(locale), { style: "currency", currency: "JPY", maximumFractionDigits: 0 }).format(amountYen);
/** A traveler-facing experience price: zero means free, while financial amounts keep using formatYen. */
export const formatExperiencePriceYen = (amountYen: number, locale: "en" | "ja" = "en") => amountYen === 0 ? (locale === "ja" ? "無料" : "Free") : formatYen(amountYen, locale);
export const formatDay = (iso: string, locale: "en" | "ja" = "en") => new Intl.DateTimeFormat(intlLocale(locale), { timeZone: TZ, weekday: "short", month: "short", day: "numeric" }).format(new Date(iso));
export const formatLongDay = (iso: string, locale: "en" | "ja" = "en") => new Intl.DateTimeFormat(intlLocale(locale), { timeZone: TZ, weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(new Date(iso));
export const formatTime = (iso: string, locale: "en" | "ja" = "en") => new Intl.DateTimeFormat(intlLocale(locale), { timeZone: TZ, hour: "numeric", minute: "2-digit" }).format(new Date(iso));
export const formatTimeRange = (startIso: string, endIso: string, locale: "en" | "ja" = "en") => `${formatTime(startIso, locale)} – ${formatTime(endIso, locale)} JST`;
export function formatDuration(minutes: number, locale: "en" | "ja" = "en") {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return locale === "ja" ? [h ? `${h}時間` : "", m ? `${m}分` : ""].filter(Boolean).join("") : [h ? `${h} hr` : "", m ? `${m} min` : ""].filter(Boolean).join(" ");
}
export const jstDateKey = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
export const pluralize = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
