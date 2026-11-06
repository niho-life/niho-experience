import { describe, expect, it } from "vitest";
import { parseChannelAdapters } from "./channel-adapters";

describe("parseChannelAdapters", () => {
  it("is an empty allowlist when unset", () => {
    expect(parseChannelAdapters(undefined)).toEqual({});
    expect(parseChannelAdapters("")).toEqual({});
  });

  it("reads the JSON form as before (docs/ota-runtime.md)", () => {
    const raw = '{"GetYourGuide/gyg-browser@1":{"canObserve":true,"canReadReservations":false,"canClose":true,"canOpen":true}}';
    expect(parseChannelAdapters(raw)).toEqual({
      "GetYourGuide/gyg-browser@1": { canObserve: true, canReadReservations: false, canClose: true, canOpen: true },
    });
    expect(parseChannelAdapters("{}")).toEqual({});
    expect(parseChannelAdapters('{"a":{}}')).toEqual({ a: {} });
    expect(parseChannelAdapters(` ${raw} `)).toEqual(parseChannelAdapters(raw));
  });

  it("refuses the whole JSON value when any part is malformed", () => {
    for (const raw of [
      "{not json",
      '{"GetYourGuide/gyg-browser@1":{"canObserve":"true"}}',
      '{"GetYourGuide/gyg-browser@1":{"canObserve":1}}',
      '{"GetYourGuide/gyg-browser@1":{"canFly":true}}',
      '{"GetYourGuide/gyg-browser@1":[true]}',
      '{"GetYourGuide/gyg-browser@1":null}',
      '{"GetYourGuide/gyg-browser@1":true}',
      '{"ok/a@1":{"canOpen":true},"bad/a@1":{"canOpen":null}}',
      JSON.stringify({ [`${"a".repeat(299)}/x@1`]: { canOpen: true } }),
    ]) {
      expect(parseChannelAdapters(raw), raw).toBeNull();
    }
    expect(parseChannelAdapters(JSON.stringify({ ["a".repeat(300)]: { canOpen: true } }))).toEqual({ ["a".repeat(300)]: { canOpen: true } });
    // A top-level array or null is not "{"-led, so it is read (and refused) as the short form.
    expect(parseChannelAdapters("[]")).toBeNull();
    expect(parseChannelAdapters("null")).toBeNull();
  });

  it("reads the short form into the same shape, with only the named capabilities set", () => {
    expect(parseChannelAdapters("GetYourGuide/gyg-browser@1=observe+close+open+create;Airbnb/airbnb-google-busy@1=observe+open+close")).toEqual({
      "GetYourGuide/gyg-browser@1": { canObserve: true, canClose: true, canOpen: true, canCreate: true },
      "Airbnb/airbnb-google-busy@1": { canObserve: true, canOpen: true, canClose: true },
    });
    expect(parseChannelAdapters("Site.v2/a_b-c@10=readReservations")).toEqual({ "Site.v2/a_b-c@10": { canReadReservations: true } });
  });

  it("refuses the whole short form when any entry is malformed", () => {
    for (const raw of [
      "GetYourGuide/gyg-browser@1=observe;GetYourGuide/gyg-browser@1=close", // duplicate key
      "GetYourGuide/gyg-browser@1=observe+observe", // duplicate capability
      "GetYourGuide/gyg-browser@1=fly", // unknown capability
      "GetYourGuide/gyg-browser@1=canObserve", // JSON names are not short words
      "GetYourGuide/gyg-browser@1=constructor", // no inherited names
      "GetYourGuide/gyg-browser@1=", // no capability
      "GetYourGuide/gyg-browser@1=observe+", // empty capability
      "GetYourGuide/gyg-browser@1", // no "="
      "GetYourGuide/gyg-browser@1=observe;", // empty entry
      ";GetYourGuide/gyg-browser@1=observe",
      "GetYourGuide/gyg-browser@1=observe,close", // comma
      "GetYourGuide/gyg-browser@1=observe;Airbnb/airbnb-google-busy@1=open,Other/x@1=open",
      "GetYourGuide/gyg-browser@1 =observe", // whitespace
      "GetYourGuide/gyg-browser@1=observe; Airbnb/airbnb-google-busy@1=open",
      "GetYourGuide/gyg-browser@1=observe\n",
      "GetYourGuide@1=observe", // key without adapter
      "GetYourGuide/gyg-browser=observe", // key without version
      "GetYourGuide/gyg-browser@v1=observe",
      "Get/Your/Guide@1=observe",
      `${"a".repeat(297)}/b@1=observe`, // a 301-character key
    ]) {
      expect(parseChannelAdapters(raw), raw).toBeNull();
    }
    expect(parseChannelAdapters(`${"a".repeat(296)}/b@1=observe`)).toEqual({ [`${"a".repeat(296)}/b@1`]: { canObserve: true } });
  });
});
