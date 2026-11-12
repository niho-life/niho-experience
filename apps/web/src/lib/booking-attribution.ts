import type { ExperienceCheckoutRequest } from "@niho-experience/api-client";
import { doNotTrackEnabled } from "./analytics";

const UTM_FIELDS = [
  ["utm_source", "utmSource"],
  ["utm_medium", "utmMedium"],
  ["utm_campaign", "utmCampaign"],
  ["utm_content", "utmContent"],
] as const;
export const SAFE_UTM_VALUE = /^[a-z0-9_-]{1,64}$/;

export type BookingAttribution = Partial<Pick<ExperienceCheckoutRequest, "utmSource" | "utmMedium" | "utmCampaign" | "utmContent">>;

/** An in-memory first-touch store. It never writes to a URL, cookie, or device storage. */
export function createBookingAttributionStore() {
  let captured: BookingAttribution = {};

  return {
    capture(search: string, doNotTrack: string | null | undefined): void {
      if (doNotTrackEnabled(doNotTrack)) {
        captured = {};
        return;
      }
      if (Object.keys(captured).length > 0) return;
      const params = new URLSearchParams(search);
      const next: BookingAttribution = {};
      for (const [urlField, bodyField] of UTM_FIELDS) {
        const value = params.get(urlField);
        if (value && SAFE_UTM_VALUE.test(value)) next[bodyField] = value;
      }
      captured = next;
    },

    read(doNotTrack: string | null | undefined): BookingAttribution {
      if (doNotTrackEnabled(doNotTrack)) {
        captured = {};
        return {};
      }
      return { ...captured };
    },
  };
}

const bookingAttribution = createBookingAttributionStore();

export function captureBookingAttribution(search: string, doNotTrack: string | null | undefined): void {
  bookingAttribution.capture(search, doNotTrack);
}

export function readBookingAttribution(doNotTrack: string | null | undefined): BookingAttribution {
  return bookingAttribution.read(doNotTrack);
}
