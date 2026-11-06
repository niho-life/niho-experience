import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ChannelListingDto } from "@niho-experience/experience-store";
import { AdvanceSlotNote, listingNeedsAdvanceSlots } from "./AdminChannelWorkspace";

type Listing = Pick<ChannelListingDto, "connectionMode" | "capabilities">;
const listing = (connectionMode: Listing["connectionMode"], capabilities: Partial<Listing["capabilities"]>): Listing => ({
  connectionMode,
  capabilities: { canObserve: true, canReadReservations: false, canClose: false, canOpen: false, canCreate: false, ...capabilities },
});
const render = (value: Listing) => renderToStaticMarkup(createElement(AdvanceSlotNote, { listing: value }));

describe("listings that cannot create an occurrence (#241)", () => {
  it("flags a browser listing that opens and closes existing occurrences but cannot create one", () => {
    expect(listingNeedsAdvanceSlots(listing("BROWSER", { canClose: true, canOpen: true }))).toBe(true);
    expect(listingNeedsAdvanceSlots(listing("API", { canOpen: true }))).toBe(true);
  });

  it("does not flag a listing that can create, one that cannot open anyway, or a Google calendar output", () => {
    expect(listingNeedsAdvanceSlots(listing("BROWSER", { canOpen: true, canCreate: true }))).toBe(false);
    // Closing alone never asks for a slot to exist first: nothing is opened.
    expect(listingNeedsAdvanceSlots(listing("BROWSER", { canClose: true }))).toBe(false);
    expect(listingNeedsAdvanceSlots(listing("BROWSER", {}))).toBe(false);
    // A Google calendar output has no occurrence to create on the other site.
    expect(listingNeedsAdvanceSlots(listing("GOOGLE", { canClose: true, canOpen: true }))).toBe(false);
  });

  it("tells the admin that the slot must exist on the external site first, and shows nothing otherwise", () => {
    const note = render(listing("BROWSER", { canClose: true, canOpen: true }));
    expect(note).toContain("開催枠を先に作っておく必要があります");
    expect(note).toContain("未対応");
    expect(render(listing("BROWSER", { canClose: true, canOpen: true, canCreate: true }))).toBe("");
    expect(render(listing("GOOGLE", { canOpen: true }))).toBe("");
  });

  it("does not name an adapter or site in the note (the notice carries only the capability)", () => {
    const note = render(listing("BROWSER", { canOpen: true }));
    expect(note).not.toMatch(/GetYourGuide|Airbnb|adapter/i);
  });
});
