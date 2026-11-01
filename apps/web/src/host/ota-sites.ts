/**
 * The reservation sites (OTA) as hosts know them (#194): the label of a site the experience DB names (CHANNEL_SITES in
 * packages/experience-store). A site this list does not know yet shows as the store names it.
 */
const OTA_SITE_LABELS: Readonly<Record<string, string>> = {
  Airbnb: "Airbnb",
  GetYourGuide: "GetYourGuide",
  Viator: "Viator",
  Klook: "Klook",
  KKday: "KKday",
  Jalan: "じゃらん",
  Asoview: "アソビュー！",
  ActivityJapan: "アクティビティジャパン",
  Rezio: "Rezio",
  Reddy: "Reddy",
};

export function otaSiteLabel(site: string): string {
  return Object.hasOwn(OTA_SITE_LABELS, site) ? OTA_SITE_LABELS[site]! : site;
}
