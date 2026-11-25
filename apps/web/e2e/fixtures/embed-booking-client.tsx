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

window.mountEmbedBooking = (acceptanceMode) => createRoot(document.getElementById("root")!).render(
  <SitePublicationBooking
    layout="embed"
    item={{
      publication: { slug: "synthetic-dinner", publicTitle: "Synthetic dinner", sellerDisplayName: "Synthetic seller" },
      saleTerms: { sellerDisplayName: "Synthetic seller", offers: [{ ...offer, acceptanceMode }] },
      sellerDisclosure: null,
    } as never}
    siteOrigin={window.location.origin}
    consentVersion="terms-v1"
    bookingsEnabled
    attributionEnabled
    defaultAttribution={{ utmSource: "provider", utmMedium: "embed" }}
  />,
);
