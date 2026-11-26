import type { SearchParams } from "@/lib/filters";
import type { SiteBookingSelection } from "@/components/pages/SitePublicationBooking";

/** Only the public date, offer and party fields are accepted from a detail-page link. */
export function siteBookingSelectionFromSearch(search: SearchParams): SiteBookingSelection | null {
  const value = (key: string): string | null => typeof search[key] === "string" ? search[key] as string : null;
  const date = value("date");
  const offerId = value("offer");
  const adultsRaw = value("adults");
  const childrenRaw = value("children");
  const parsedDate = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T00:00:00.000Z`) : null;
  if (!date || !parsedDate || !Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== date
    || !offerId || !/^[A-Za-z0-9_-]{1,64}$/.test(offerId)
    || adultsRaw === null || !/^\d+$/.test(adultsRaw)
    || childrenRaw === null || !/^\d+$/.test(childrenRaw)) return null;
  const adults = Number(adultsRaw);
  const children = Number(childrenRaw);
  if (!Number.isSafeInteger(adults) || !Number.isSafeInteger(children)) return null;
  return { date, offerId, adults, children };
}
