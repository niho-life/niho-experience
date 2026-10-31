import type { ExperienceApiClient, Occurrence, OfferId } from "@niho-experience/api-client";
import { getBrowserApi, getSiteBookingApi } from "./browser-api";
import type { BookingSource } from "./booking-source";

/**
 * Browser-only availability reads for display (next dates, list filtering).
 * Requests made at the same moment for the same experience share one fetch (the
 * detail page's booking card and mobile bar both need it); nothing is kept longer
 * than a few seconds because availability is never cached.
 */

export type AvailabilityRead = { ok: true; occurrences: Occurrence[] } | { ok: false };

const SHARE_MS = 5_000;
const inflight = new Map<string, { at: number; promise: Promise<AvailabilityRead> }>();

export async function readAvailabilityFromApi(api: ExperienceApiClient, slug: string, locale: "en" | "ja", releaseId: string | null, offerId?: OfferId): Promise<Occurrence[] | null> {
  if (locale === "ja") {
    const result = await api.getJapaneseAvailability(slug, offerId ? { offerId } : {});
    return result.ok && result.data.releaseId === releaseId ? result.data.occurrences : null;
  }
  const result = await api.getAvailability(slug, offerId ? { offerId } : {});
  return result.ok ? result.data.occurrences : null;
}

function sharedRead(key: string, read: () => Promise<Occurrence[] | null>): Promise<AvailabilityRead> {
  const now = Date.now();
  const shared = inflight.get(key);
  if (shared && now - shared.at < SHARE_MS) return shared.promise;
  const promise = read()
    .then((occurrences): AvailabilityRead => occurrences ? { ok: true, occurrences } : { ok: false })
    .catch((): AvailabilityRead => ({ ok: false }));
  inflight.set(key, { at: now, promise });
  // Share concurrent failures, but let an explicit retry reach the API immediately.
  void promise.then((result) => {
    if (!result.ok && inflight.get(key)?.promise === promise) inflight.delete(key);
  });
  return promise;
}

export function readAvailability(slug: string, preview: boolean, nihoWebOrigin: string, locale: "en" | "ja" = "en", releaseId: string | null = null): Promise<AvailabilityRead> {
  return sharedRead(`${preview ? "mock" : "http"}|${nihoWebOrigin}|${locale}|${releaseId ?? ""}|${slug}`, () =>
    getBrowserApi(preview, nihoWebOrigin).then((api) => readAvailabilityFromApi(api, slug, locale, releaseId)));
}

/**
 * The same read from where the server says the experience is sold (#285): NIHO's API, this site's own route,
 * or nothing when the server could not tell (a failed read, so lists fail open and cards keep their schedule
 * line). This site has one availability for both languages; dates and times are the same in Japanese.
 */
export function readBookingAvailability(slug: string, preview: boolean, source: BookingSource, locale: "en" | "ja" = "en", releaseId: string | null = null): Promise<AvailabilityRead> {
  if (source.kind === "closed") return Promise.resolve({ ok: false });
  if (source.kind === "niho") return readAvailability(slug, preview, source.origin, locale, releaseId);
  return sharedRead(`site|${source.origin}|${slug}`, async () => {
    const result = await getSiteBookingApi(source.origin).getAvailability(slug);
    return result.ok ? result.data.occurrences : null;
  });
}
