/**
 * Where the browser reads an experience's availability and starts its checkout (#285, docs/guest-booking.md).
 * The server decides it per product (guest-booking-source.ts) and hands it to the client components:
 * - "niho": NIHO's public API, for every product not sold here, the preview, and while the flag is off.
 * - "site": this site's own routes (`/api/public/experiences/{slug}/availability`, `…/checkout`), for a
 *   product the experience DB sells. A switched product's traveler never reaches NIHO's availability or checkout.
 * - "closed": the server could not tell (the experience DB failed): nothing is read and no booking is offered.
 */
export type BookingSource =
  | { readonly kind: "niho"; readonly origin: string }
  | { readonly kind: "site"; readonly origin: string }
  | { readonly kind: "closed" };

/** The same choice for a page of cards. Slugs named in neither list use NIHO's API. */
export type BookingSources = {
  readonly nihoWebOrigin: string;
  /** This site's origin; null when no slug is sold here. */
  readonly siteOrigin: string | null;
  readonly siteSlugs: readonly string[];
  readonly closedSlugs: readonly string[];
};

/** Every slug on NIHO's API: the preview, the flag off, or a page with no product sold here. */
export function nihoBookingSources(nihoWebOrigin: string): BookingSources {
  return { nihoWebOrigin, siteOrigin: null, siteSlugs: [], closedSlugs: [] };
}

export function bookingSourceFor(sources: BookingSources, slug: string): BookingSource {
  if (sources.closedSlugs.includes(slug)) return { kind: "closed" };
  if (sources.siteOrigin !== null && sources.siteSlugs.includes(slug)) return { kind: "site", origin: sources.siteOrigin };
  return { kind: "niho", origin: sources.nihoWebOrigin };
}

/** A string that changes when the source does, for effect dependencies and shared reads. */
export function bookingSourceKey(source: BookingSource): string {
  return source.kind === "closed" ? "closed" : `${source.kind}|${source.origin}`;
}
