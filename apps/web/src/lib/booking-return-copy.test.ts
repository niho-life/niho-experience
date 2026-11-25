import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BookingReturn } from "@/components/BookingReturn";
import { bookingReturnCopy, readReturnType } from "./booking-return-copy";

describe("booking return copy (#638)", () => {
  it.each([
    ["managed-request", false, "NIHO will review your request", "Submitting a request does not require a card"],
    ["instant", true, "Check your email for your free booking", "No payment is due."],
    ["instant", false, "Check your email for your booking", "once your payment goes through"],
  ] as const)("says what follows a %s booking (free: %s)", (type, free, heading, lead) => {
    const copy = bookingReturnCopy(type, free, "en");
    expect(copy.heading).toBe(heading);
    expect(copy.lead).toContain(lead);
  });

  it.each([
    ["managed-request", false, "お申込みを受け付けました", "まだ予約は確定していません。"],
    ["instant", true, "無料のご予約の確認メールをご確認ください", "お支払いは不要です。"],
    ["instant", false, "ご予約の確認メールをご確認ください", "お支払いが完了すると"],
  ] as const)("says the same in Japanese for %s (free: %s)", (type, free, heading, lead) => {
    const copy = bookingReturnCopy(type, free, "ja");
    expect(copy.heading).toBe(heading);
    expect(copy.lead).toContain(lead);
  });

  it("is the return page's own heading and lead", () => {
    for (const locale of ["en", "ja"] as const) {
      for (const [type, freeBooking] of [["instant", false], ["instant", true], ["managed-request", false], ["approval", false], [null, false]] as const) {
        const copy = bookingReturnCopy(type, freeBooking, locale);
        const html = renderToStaticMarkup(createElement(BookingReturn, { type, freeBooking, showReview: false, locale }));
        expect(html).toContain(`<h1 class="mt-1 text-3xl">${copy.heading}</h1>`);
        expect(html).toContain(copy.lead);
      }
    }
  });

  it("reads only the fixed words", () => {
    expect(readReturnType("instant")).toBe("instant");
    expect(readReturnType("managed-request")).toBe("managed-request");
    expect(readReturnType("anything")).toBeNull();
    expect(readReturnType(null)).toBeNull();
  });
});
