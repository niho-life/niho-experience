import { describe, expect, it } from "vitest";
import { publicationCanPublish, publicationNextAction } from "./publication-workflow";

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
});
