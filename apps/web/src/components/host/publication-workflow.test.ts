import { describe, expect, it } from "vitest";
import { publicationBlockerDestination, publicationCanPublish, publicationNextAction } from "./publication-workflow";

describe("host publication next action", () => {
  it("guides a saved new product through schedule, pricing, content and publish", () => {
    expect(publicationNextAction({ dirty: false, blockers: ["SCHEDULE_REQUIRED", "PRICE_REQUIRED"], published: false })).toBe("SCHEDULE");
    expect(publicationNextAction({ dirty: false, blockers: ["PRICE_REQUIRED", "MANUSCRIPT_REQUIRED"], published: false })).toBe("PRICING");
    expect(publicationNextAction({ dirty: false, blockers: ["MANUSCRIPT_REQUIRED"], published: false })).toBe("MANUSCRIPT");
    expect(publicationNextAction({ dirty: false, blockers: [], published: false })).toBe("PUBLISH");
  });

  it("never presents publish as available for unsaved, blocked, or suspended state", () => {
    expect(publicationCanPublish({ dirty: true, blockers: [], suspended: false })).toBe(false);
    expect(publicationCanPublish({ dirty: false, blockers: ["PHOTOS_REQUIRED"], suspended: false })).toBe(false);
    expect(publicationCanPublish({ dirty: false, blockers: [], suspended: true })).toBe(false);
    expect(publicationCanPublish({ dirty: false, blockers: [], suspended: false })).toBe(true);
  });

  it("takes the OWNER to support/fee consent before offering publication", () => {
    expect(publicationNextAction({ dirty: false, blockers: ["SUPPORT_CONSENT_REQUIRED"], published: false })).toBe("SUPPORT");
    expect(publicationCanPublish({ dirty: false, blockers: ["SUPPORT_CONSENT_REQUIRED"], suspended: false })).toBe(false);
  });

  it("guides current-account consent without bypassing saved-content or support requirements", () => {
    const blockers = ["PAYMENT_REUSE_CONSENT_REQUIRED"];
    expect(publicationNextAction({ dirty: false, blockers, published: false })).toBe("PAYMENT_CONSENT");
    expect(publicationNextAction({ dirty: true, blockers, published: false })).toBe("SAVE");
    expect(publicationNextAction({ dirty: false, blockers: [...blockers, "SCHEDULE_REQUIRED"], published: false })).toBe("SCHEDULE");
    expect(publicationNextAction({ dirty: false, blockers: [...blockers, "SUPPORT_CONSENT_REQUIRED"], published: false })).toBe("SUPPORT");
    expect(publicationCanPublish({ dirty: false, blockers, suspended: false })).toBe(false);
  });
});

describe("publication blocker destination", () => {
  it("sends each blocker to the place that fixes it", () => {
    expect(publicationBlockerDestination("SCHEDULE_REQUIRED")).toEqual({ kind: "calendar" });
    expect(publicationBlockerDestination("PRICE_REQUIRED")).toEqual({ kind: "tab", tab: "pricing" });
    expect(publicationBlockerDestination("CANCELLATION_TERMS_REQUIRED")).toEqual({ kind: "tab", tab: "pricing" });
    for (const blocker of ["MANUSCRIPT_REQUIRED", "PUBLIC_CONTENT_INVALID", "PHOTOS_REQUIRED"]) expect(publicationBlockerDestination(blocker)).toEqual({ kind: "tab", tab: "page" });
    expect(publicationBlockerDestination("SLUG_IN_USE")).toEqual({ kind: "tab", tab: "settings" });
    expect(publicationBlockerDestination("NOTIFICATION_ADDRESS_REQUIRED")).toEqual({ kind: "href", href: "/host/settings#settings-notification" });
    expect(publicationBlockerDestination("SUPPORT_CONSENT_REQUIRED")).toEqual({ kind: "href", href: "/host/settings#settings-support" });
    expect(publicationBlockerDestination("PAYMENT_REUSE_CONSENT_REQUIRED")).toEqual({ kind: "payment-consent" });
  });

  it("has no destination for the rest", () => {
    for (const blocker of ["CONNECT_NOT_READY", "FEE_SETTINGS_REQUIRED", "OPERATIONS_SUSPENDED", "UNKNOWN"]) expect(publicationBlockerDestination(blocker)).toBeNull();
  });
});
