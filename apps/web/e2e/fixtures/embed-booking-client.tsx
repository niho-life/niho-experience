import React from "react";
import { createRoot } from "react-dom/client";
import { SitePublicationBooking } from "../../src/components/pages/SitePublicationBooking";

// The booking widget (#638) on a synthetic experience, mounted inside a frame of another origin (e2e/embed-booking.spec.ts).
Object.assign(globalThis, { React });

const offer = {
  id: "synthetic-offer", name: "Synthetic evening", shortDescription: null,
  pricing: { currency: "JPY", taxIncluded: true, adultPriceYen: 5000, child: null },
  capacity: 6, maxPartySize: 6, minimumParticipants: 1, minimumChargeableParticipants: 1,
  durationMinutes: 120, startTime: "18:00", weekdays: [6],
  cancellationPolicy: { code: "CUSTOM", freeCancellationHoursBefore: null },
  cancellationTerms: { cancellationWindowMinutesBeforeStart: 1440, refundBasisPoints: 5000 },
  acceptanceMode: "INSTANT", bookingQuestions: [], bookingQuestionsFingerprint: "0".repeat(64),
};

window.mountEmbedBooking = (acceptanceMode, options = {}) => createRoot(document.getElementById("root")!).render(
  <SitePublicationBooking
    layout={options.layout ?? "embed"}
    preview={options.preview ?? false}
    item={{
      publication: { slug: "synthetic-dinner", publicTitle: "Synthetic dinner", sellerDisplayName: "Synthetic seller" },
      // 開催枠ごとに offer が分かれる: a second offer is the same experience at another time and price.
      saleTerms: { sellerDisplayName: "Synthetic seller", offers: [{ ...offer, acceptanceMode }, ...(options.secondOffer ? [{ ...offer, acceptanceMode, id: "synthetic-offer-noon", startTime: "12:00", weekdays: [0, 6], pricing: { ...offer.pricing, adultPriceYen: 4000 } }] : [])] },
      sellerDisclosure: null,
    } as never}
    siteOrigin={window.location.origin}
    consentVersion="terms-v1"
    bookingsEnabled
    attributionEnabled
    defaultAttribution={options.layout === "page" ? undefined : { utmSource: "provider", utmMedium: "embed" }}
  />,
);
