import { describe, expect, it } from "vitest";

import { decodeExperienceProviderPageListingRequest, decodeExperienceProviderPageMeetingPointUpdateRequest } from "../src/host/schema.ts";

const version = "2026-10-27T01:00:00.000Z";
const meetingPoint = { overview: "（合成）駅の近く", address: "（合成）サンプル町 1 丁目", accessNote: "", mapUrl: "https://maps.example.test/sample", entranceNote: "（合成）木の門" };

describe("host request decoders (the contract's own schemas)", () => {
  it("accepts a page meeting point OVERRIDE with all five fields, or INHERIT with the version only", () => {
    expect(decodeExperienceProviderPageMeetingPointUpdateRequest({ mode: "OVERRIDE", meetingPoint, expectedUpdatedAt: version })).toEqual({ mode: "OVERRIDE", meetingPoint, expectedUpdatedAt: version });
    expect(decodeExperienceProviderPageMeetingPointUpdateRequest({ mode: "OVERRIDE", meetingPoint: { ...meetingPoint, mapUrl: "" }, expectedUpdatedAt: version })).not.toBeNull();
    expect(decodeExperienceProviderPageMeetingPointUpdateRequest({ mode: "INHERIT", expectedUpdatedAt: version })).toEqual({ mode: "INHERIT", expectedUpdatedAt: version });
  });

  it("refuses missing or unknown fields, values over the limits and a map URL that is not https", () => {
    for (const body of [
      { mode: "INHERIT" },
      { mode: "INHERIT", expectedUpdatedAt: version, meetingPoint },
      { mode: "OVERRIDE", expectedUpdatedAt: version },
      { mode: "OVERRIDE", meetingPoint: { ...meetingPoint, entranceNote: undefined }, expectedUpdatedAt: version },
      { mode: "OVERRIDE", meetingPoint: { ...meetingPoint, phone: "000" }, expectedUpdatedAt: version },
      { mode: "OVERRIDE", meetingPoint: { ...meetingPoint, overview: "x".repeat(201) }, expectedUpdatedAt: version },
      { mode: "OVERRIDE", meetingPoint: { ...meetingPoint, mapUrl: "http://maps.example.test/sample" }, expectedUpdatedAt: version },
      { mode: "OVERRIDE", meetingPoint, expectedUpdatedAt: "yesterday" },
      { mode: "DEFAULT", expectedUpdatedAt: version },
      null,
    ]) expect(decodeExperienceProviderPageMeetingPointUpdateRequest(body)).toBeNull();
  });

  it("accepts a listing request with the consent version only", () => {
    expect(decodeExperienceProviderPageListingRequest({ consentVersion: "sample-listing-consent-1" })).toEqual({ consentVersion: "sample-listing-consent-1" });
    for (const body of [{}, { consentVersion: "" }, { consentVersion: "x".repeat(101) }, { consentVersion: "v1", slug: "mine" }, { consentVersion: 1 }, []]) {
      expect(decodeExperienceProviderPageListingRequest(body)).toBeNull();
    }
  });
});
