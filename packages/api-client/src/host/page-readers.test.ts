import { describe, expect, it } from "vitest";
import { readPageListingResponse } from "./page-readers.ts";

const listing = {
  id: "listing_1",
  spotId: "spot_1",
  campaignPageId: "page_1",
  status: "PAUSED",
  slug: null,
  regionKey: null,
  consentVersion: "consent_1",
  consentedAt: "2026-11-01T00:00:00.000Z",
  approvedAt: null,
  pausedAt: "2026-11-01T00:00:00.000Z",
  withdrawnAt: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
};
const consent = { version: "consent_1", text: "掲載条件に同意します。" };

describe("readPageListingResponse", () => {
  it("reads reviewer reasons from the host listing response", () => {
    expect(readPageListingResponse({
      listing: { ...listing, reviewNote: "集合案内の公開範囲を見直してください。", reviewNotedAt: "2026-11-01T00:00:00.000Z" },
      consent,
    })?.listing).toMatchObject({ reviewNote: "集合案内の公開範囲を見直してください。", reviewNotedAt: "2026-11-01T00:00:00.000Z" });
  });

  it("treats fields absent from the deployed v0.3 response as null during rollout", () => {
    expect(readPageListingResponse({ listing, consent })?.listing).toMatchObject({ reviewNote: null, reviewNotedAt: null });
  });

  it("rejects malformed reviewer reasons", () => {
    expect(readPageListingResponse({ listing: { ...listing, reviewNote: { internal: true }, reviewNotedAt: null }, consent })).toBeNull();
  });
});
