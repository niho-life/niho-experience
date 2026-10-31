import { createExperienceApiClient, type ExperienceApiClient } from "@niho-experience/api-client";
import type { BookingSource } from "./booking-source";
import { parseSiteSaleTerms, type SiteSaleTerms } from "./guest-booking-terms";

const previewAvailabilityFailures = new Set<string>();

/**
 * Browser only: questions to the host (#105) go to this site's own route, which keeps them in the experience
 * DB (docs/guest-questions.md), not to NIHO. `same-origin` replaces the client's no-referrer for these POSTs so
 * they carry this site's Origin, which the route checks; the Referer is this site's own page.
 */
export function getSiteQuestionsApi(siteOrigin: string) {
  return createExperienceApiClient({ nihoWebOrigin: siteOrigin, fetch: (input, init) => fetch(input, { ...init, referrerPolicy: "same-origin" }) });
}

/**
 * Browser only: an experience sold on this site (#285, docs/guest-booking.md) reads availability and starts its
 * checkout at this site's own routes, at NIHO's paths and in NIHO's shapes. As for questions, `same-origin` lets
 * the checkout POST carry this site's Origin, which the route checks. `thisSite` accepts the site's own
 * `/booking/return` as a checkout answer (a booking already paid) and no NIHO booking page.
 */
export function getSiteBookingApi(siteOrigin: string) {
  return createExperienceApiClient({ nihoWebOrigin: siteOrigin, thisSite: true, fetch: (input, init) => fetch(input, { ...init, referrerPolicy: "same-origin" }) });
}

/** Browser only: the client for one experience's availability and checkout, from where the server says it is sold. */
export async function getBookingApi(preview: boolean, source: BookingSource): Promise<ExperienceApiClient> {
  if (source.kind === "closed") throw new Error("Booking source unknown");
  return source.kind === "site" ? getSiteBookingApi(source.origin) : getBrowserApi(preview, source.origin);
}

/**
 * Browser only: the sale terms of an experience sold here, read again from this site after the checkout said the
 * questions, the price or the terms changed (`/api/public/experiences/{slug}/booking-terms`). Null on any failure.
 */
export async function getSiteBookingTerms(siteOrigin: string, slug: string): Promise<SiteSaleTerms | null> {
  try {
    const response = await fetch(`${new URL(siteOrigin).origin}/api/public/experiences/${encodeURIComponent(slug)}/booking-terms`, {
      method: "GET", headers: { accept: "application/json" }, cache: "no-store", credentials: "omit", redirect: "error",
      referrerPolicy: "same-origin", signal: AbortSignal.timeout(10_000),
    });
    return response.status === 200 ? parseSiteSaleTerms(await response.json()) : null;
  } catch {
    return null;
  }
}

/** Browser only: availability and guest checkout use this client directly. */
export async function getBrowserApi(preview: boolean, nihoWebOrigin: string) {
  if (!preview) return createExperienceApiClient({ nihoWebOrigin });
  const { createMockExperienceFetch } = await import("@niho-experience/api-client/mock");
  // Preview-only error states let the booking flow be exercised end to end.
  const requested = new URLSearchParams(window.location.search).get("mock");
  const scenarios = {
    "checkout-full": "checkout-full",
    "checkout-hold-limit": "checkout-hold-limit",
    "checkout-price-changed": "checkout-price-changed",
    "checkout-questions-changed": "checkout-questions-changed",
    "checkout-consent-outdated": "checkout-consent-outdated",
    "checkout-conditions-outdated": "checkout-conditions-outdated",
    "checkout-conditions-added": "checkout-conditions-added",
    "checkout-rate-limited": "checkout-rate-limited",
    "checkout-unavailable": "checkout-unavailable",
    // The question to the host (provisional contract, Epic #103) fails in its own ways.
    "ask-rate-limited": "ask-rate-limited",
    "ask-unavailable": "ask-unavailable",
    "ask-send-failed": "ask-send-failed",
    // Reviews: the page may be rendered with them, and only "Show all" (read in the browser) fails.
    "reviews-error": "reviews-error",
    "reviews-more-error": "reviews-error",
  } as const;
  const scenario = scenarios[requested as keyof typeof scenarios] ?? "default";
  // "all": the server may render either mock catalog; slugs never overlap.
  const mockFetch = createMockExperienceFetch({ catalog: "all", scenario });
  return createExperienceApiClient({ nihoWebOrigin, fetch: async (input, init) => {
    // Preview-only recovery exercise: fail each availability read once per document.
    const path = new URL(input).pathname;
    if (requested === "availability-retry" && path.endsWith("/availability") && !previewAvailabilityFailures.has(path)) {
      previewAvailabilityFailures.add(path);
      throw new TypeError("Preview availability unavailable");
    }
    return mockFetch(input, init);
  } });
}
