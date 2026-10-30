import { describe, expect, it } from "vitest";
import { EMPTY_MEETING_POINT, meetingMapUrlValid, normalizeMeetingPoint, sameMeetingPoint } from "./meeting-point";

const place = { overview: "（合成）駅の近く", address: "（合成）サンプル町", accessNote: "", mapUrl: "https://maps.example.test/sample", entranceNote: "（合成）門" };

describe("meeting point", () => {
  it("keeps the five fields trimmed, as NIHO does", () => {
    expect(normalizeMeetingPoint({ ...place, overview: "  （合成）駅の近く \n" })).toEqual(place);
    expect(normalizeMeetingPoint(EMPTY_MEETING_POINT)).toEqual(EMPTY_MEETING_POINT);
    expect(normalizeMeetingPoint({ ...place, overview: ` ${"x".repeat(200)} ` })?.overview).toHaveLength(200);
  });

  it("refuses a missing or unknown field, a value over the limit and a map URL that is not plain https", () => {
    for (const value of [null, [], { ...place, overview: "x".repeat(201) }, { ...place, phone: "0" }, { overview: "", address: "", accessNote: "", mapUrl: "" }, { ...place, mapUrl: "http://maps.example.test" }]) {
      expect(normalizeMeetingPoint(value)).toBeNull();
    }
    expect(["", "https://maps.example.test/a?b=1"].map(meetingMapUrlValid)).toEqual([true, true]);
    expect(["https://", "HTTPS://maps.example.test", "https://user:pw@maps.example.test", "ftp://maps.example.test", "maps.example.test"].map(meetingMapUrlValid)).toEqual([false, false, false, false, false]);
  });

  it("treats spaces around a value as no change", () => {
    expect(sameMeetingPoint({ ...place, address: " （合成）サンプル町 " }, place)).toBe(true);
    expect(sameMeetingPoint({ ...place, address: "（合成）別の町" }, place)).toBe(false);
  });
});
