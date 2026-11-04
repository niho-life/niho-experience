import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StoreValidationError } from "../src/errors.ts";
import { validateGuestMeetingGuide } from "../src/guest-meeting-guides.ts";

const guide = {
  collectionOverview: "Blue flag",
  address: "1-2-3 Kamakura",
  accessInstructions: "Walk east.",
  entranceInstructions: "Use the garden gate.",
  mapUrl: null,
  photoAssetId: "00000000-0000-4000-8000-000000000401",
  itemsToBring: ["Water bottle"],
  weatherPlan: "Move indoors.",
};

describe("guest booking guide validation", () => {
  it("preserves newlines in multiline meeting fields and normalizes CRLF", () => {
    assert.deepEqual(validateGuestMeetingGuide({
      ...guide,
      address: "1-2-3 Kamakura\r\nRoom 4",
      accessInstructions: "Leave the station\nTurn left at the postbox",
      entranceInstructions: "Use the garden gate.\r",
      weatherPlan: "Move indoors\nif it rains",
    }), {
      ...guide,
      address: "1-2-3 Kamakura\nRoom 4",
      accessInstructions: "Leave the station\nTurn left at the postbox",
      entranceInstructions: "Use the garden gate.",
      weatherPlan: "Move indoors\nif it rains",
    });
  });

  it("continues to reject non-newline control characters in multiline fields", () => {
    assert.throws(() => validateGuestMeetingGuide({ ...guide, accessInstructions: "Walk\tleft" }), StoreValidationError);
  });
});
