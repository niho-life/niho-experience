import { describe, expect, it } from "vitest";
import type { BookingConfirmationEmail, BookingLinkEmail } from "@niho-experience/experience-store";
import { bookingConfirmationEmail, bookingLinkEmail, questionReplyEmail, type RenderedMail } from "./templates";

/** The guest emails (#285 slice 5) with synthetic data only. */
const SITE = "https://experience.example";
const TOKEN = "sampleTokenAbcdefghijklmnopqrstuvwxyz0123456";

const reply = {
  siteUrl: SITE,
  guestName: "Sample Guest",
  hostName: "Sample Host",
  experienceTitle: "Synthetic tea ceremony",
  reply: "Yes, we have a vegetarian option.\nSee you soon!",
  replyToken: TOKEN,
  linkTtlDays: 14,
};

const confirmation: BookingConfirmationEmail = {
  publicBookingId: "0f8fad5b-d9cb-469f-a165-70867728950e",
  guestEmail: "guest@example.com",
  guestName: "Sample Guest",
  experienceTitle: "Synthetic tea ceremony",
  experienceSlug: "sample-tea",
  localDate: "2026-11-14",
  localStartTime: "10:00",
  timeZone: "Asia/Tokyo",
  startUtc: "2026-11-14T01:00:00.000Z",
  adultCount: 2,
  childCount: 1,
  totalAmount: 10_000,
  currency: "JPY",
  cancellationPolicy: "FREE_UNTIL_24H",
  hostDisplayName: "Sample Host",
};
const NOW = new Date("2026-11-01T00:00:00.000Z");

/** Every link in both parts. */
function links(mail: RenderedMail): string[] {
  return [...mail.text.matchAll(/https?:\/\/\S+/g), ...mail.html.matchAll(/href="([^"]*)"/g)].map((match) => match[1] ?? match[0]);
}

/** The lines of the text part that carry `value`. */
const linesWith = (mail: RenderedMail, value: string) => mail.text.split("\n").filter((line) => line.includes(value));

describe("questionReplyEmail", () => {
  it("names the host and the experience, quotes the reply and links to the reply page with the token in the fragment only", () => {
    const mail = questionReplyEmail(reply);
    expect(mail.subject).toBe("Sample Host replied to your question about Synthetic tea ceremony");
    expect(mail.text).toContain("Yes, we have a vegetarian option.\nSee you soon!");
    expect(mail.html).toContain("Yes, we have a vegetarian option.<br>See you soon!");
    expect(mail.text).toContain("You can answer once with it, within 14 days.");
    expect(mail.text).toContain("Replying to this email reaches NIHO support, not Sample Host.");
    for (const part of [mail.subject, mail.text, mail.html]) {
      const at = [...part.matchAll(new RegExp(TOKEN, "g"))].map((match) => part.slice(0, match.index));
      expect(at.every((before) => before.endsWith(`${SITE}/questions/reply#t=`))).toBe(true);
    }
    expect(linesWith(mail, TOKEN)).toEqual([`${SITE}/questions/reply#t=${TOKEN}`]);
    expect(mail.html).toContain(`href="${SITE}/questions/reply#t=${TOKEN}"`);
    expect(links(mail).every((href) => href.startsWith(`${SITE}/`))).toBe(true);
  });

  it("puts the guest's name in the greeting only, and nothing remote or tracked in the HTML", () => {
    const mail = questionReplyEmail(reply);
    expect(linesWith(mail, "Sample Guest")).toEqual(["Hi Sample Guest,"]);
    expect(mail.subject).not.toContain("Sample Guest");
    expect(mail.html.match(/Sample Guest/g)).toHaveLength(1);
    expect(`${mail.text}${mail.html}`).not.toMatch(/@/);
    expect(mail.html).not.toMatch(/<img|<script|<link|<style|src=|url\(|@import/i);
    expect(mail.html).toMatch(/^<!doctype html>\n<html lang="en">/);
  });

  it("escapes what anyone wrote and keeps the subject on one line", () => {
    const mail = questionReplyEmail({
      ...reply,
      hostName: "Sample\r\nBcc: other@example.com",
      experienceTitle: "Tea <b>ceremony</b>",
      reply: "<script>alert(1)</script> & \"quotes\"",
      guestName: "Guest <img src=x>",
    });
    expect(mail.subject).toBe("Sample Bcc: other@example.com replied to your question about Tea <b>ceremony</b>");
    expect(mail.subject).not.toMatch(/[\r\n]/);
    expect(mail.html).not.toMatch(/<script|<img|<b>/);
    expect(mail.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quotes&quot;");
    expect(mail.html).toContain("<title>Sample Bcc: other@example.com replied to your question about Tea &lt;b&gt;ceremony&lt;/b&gt;</title>");
  });

  it("keeps a token that is not URL-safe inside the fragment", () => {
    const mail = questionReplyEmail({ ...reply, replyToken: "a/b?c#d" });
    expect(linesWith(mail, "/questions/reply")).toEqual([`${SITE}/questions/reply#t=a%2Fb%3Fc%23d`]);
  });
});

describe("bookingConfirmationEmail", () => {
  it("says what was booked, for when, for whom and for how much, with the policy, the host and a link to the experience", () => {
    const mail = bookingConfirmationEmail(confirmation, { siteUrl: SITE, now: NOW });
    expect(mail.subject).toBe("Your booking is confirmed: Synthetic tea ceremony, Sat 14 Nov 2026 10:00");
    expect(mail.text).toContain([
      "Experience: Synthetic tea ceremony",
      "Date: Saturday 14 November 2026",
      "Time: 10:00 Japan time",
      "Guests: 2 adults, 1 child",
      "Total paid: ¥10,000",
      "Host: Sample Host",
      `Booking reference: ${confirmation.publicBookingId}`,
    ].join("\n"));
    expect(mail.text).toContain("Free cancellation until Fri 13 Nov, 10:00 Japan time (24 hours before the start). After that, the booking is non-refundable.");
    expect(mail.text).toContain("Sample Host will share the meeting details with you before the day.");
    expect(mail.text).toContain("Reply to this email and NIHO support will help.");
    expect(linesWith(mail, "https://")).toEqual([`${SITE}/experiences/sample-tea`]);
    expect(mail.html).toContain(`<a href="${SITE}/experiences/sample-tea"`);
    expect(links(mail).every((href) => href.startsWith(`${SITE}/`))).toBe(true);
    expect(mail.html).toContain('<th scope="row" style="padding:2px 16px 2px 0;text-align:left;vertical-align:top;font-weight:600">Total paid</th><td style="padding:2px 0">¥10,000</td>');
  });

  it("states each policy in plain words, and a deadline already passed as non-refundable", () => {
    const text = (overrides: Partial<BookingConfirmationEmail>, now = NOW) => bookingConfirmationEmail({ ...confirmation, ...overrides }, { siteUrl: SITE, now }).text;
    expect(text({ cancellationPolicy: "FREE_UNTIL_48H" })).toContain("Free cancellation until Thu 12 Nov, 10:00 Japan time (48 hours before the start).");
    expect(text({ cancellationPolicy: "NONE" })).toContain("This booking is non-refundable.");
    expect(text({}, new Date("2026-11-13T12:00:00.000Z"))).toContain("Free cancellation ends 24 hours before the start, so this booking is now non-refundable.");
    expect(text({ cancellationPolicy: null })).not.toMatch(/refund|cancellation/i);
    expect(text({ adultCount: 1, childCount: 0 })).toContain("Guests: 1 adult\n");
    expect(text({ adultCount: 0, childCount: 2 })).toContain("Guests: 2 children\n");
  });

  it("puts the guest's name in the greeting only, never the address, the meeting point or anything remote", () => {
    const mail = bookingConfirmationEmail(confirmation, { siteUrl: SITE, now: NOW });
    expect(linesWith(mail, "Sample Guest")).toEqual(["Hi Sample Guest,"]);
    expect(mail.subject).not.toContain("Sample Guest");
    expect(mail.html.match(/Sample Guest/g)).toHaveLength(1);
    expect(`${mail.subject}${mail.text}${mail.html}`).not.toMatch(/@|guest@example\.com/);
    expect(mail.text).not.toMatch(/meeting point|address:/i);
    expect(mail.html).not.toMatch(/<img|<script|<link|<style|src=|url\(|@import/i);
  });

  it("escapes the stored titles and names and keeps a slug inside the path", () => {
    const mail = bookingConfirmationEmail({ ...confirmation, experienceTitle: "Tea\n<i>ceremony</i>", hostDisplayName: "Host & Co", experienceSlug: "../sample tea?x" }, { siteUrl: SITE, now: NOW });
    expect(mail.subject).toBe("Your booking is confirmed: Tea <i>ceremony</i>, Sat 14 Nov 2026 10:00");
    expect(mail.html).not.toContain("<i>");
    expect(mail.html).toContain("Host &amp; Co");
    expect(linesWith(mail, "https://")).toEqual([`${SITE}/experiences/..%2Fsample%20tea%3Fx`]);
  });
});

describe("the booking page links (#285 slice 6)", () => {
  const GRANT = "sampleGrantAbcdefghijklmnopqrstuvwxyz012345";
  const link: BookingLinkEmail = {
    publicBookingId: confirmation.publicBookingId, guestEmail: "guest@example.com", guestName: "Sample Guest",
    experienceTitle: "Synthetic tea ceremony", localDate: "2026-11-14", localStartTime: "10:00", timeZone: "Asia/Tokyo",
  };

  /** The grant appears only right after `/bookings/open#g=`: never in a path, a query or the subject. */
  function grantOnlyInFragment(mail: RenderedMail): void {
    expect(mail.subject).not.toContain(GRANT);
    for (const part of [mail.text, mail.html]) {
      const at = [...part.matchAll(new RegExp(GRANT, "g"))].map((match) => part.slice(0, match.index));
      expect(at.length).toBeGreaterThan(0);
      expect(at.every((before) => before.endsWith(`${SITE}/bookings/open#g=`))).toBe(true);
    }
    expect(linesWith(mail, GRANT)).toEqual([`${SITE}/bookings/open#g=${GRANT}`]);
    expect(mail.html).toContain(`<a href="${SITE}/bookings/open#g=${GRANT}" style="color:#2f5d2a">View your booking</a>`);
    expect(links(mail).every((href) => href.startsWith(`${SITE}/`))).toBe(true);
  }

  it("adds the booking page to the confirmation only with a grant, the grant in the fragment only", () => {
    const mail = bookingConfirmationEmail(confirmation, { siteUrl: SITE, now: NOW, bookingPageGrant: GRANT });
    grantOnlyInFragment(mail);
    expect(mail.text).toContain(`The link works once and opens the booking on one device, so please don't forward it. You can ask for a new link any time at ${SITE}/bookings\n`);
    expect(linesWith(mail, "https://").filter((line) => !line.startsWith("See your booking"))).toEqual([`${SITE}/bookings/open#g=${GRANT}`, `${SITE}/experiences/sample-tea`]);
    for (const grant of [null, undefined]) {
      expect(bookingConfirmationEmail(confirmation, { siteUrl: SITE, now: NOW, bookingPageGrant: grant }).text).not.toContain("/bookings");
    }
  });

  it("emails the link Find your booking asked for: the booking it opens, the grant in the fragment, nothing else personal", () => {
    const mail = bookingLinkEmail(link, { siteUrl: SITE, bookingPageGrant: GRANT });
    expect(mail.subject).toBe("Your booking link: Synthetic tea ceremony, Sat 14 Nov 2026 10:00");
    expect(mail.text).toContain([
      "Experience: Synthetic tea ceremony",
      "Date: Saturday 14 November 2026",
      "Time: 10:00 Japan time",
      `Booking reference: ${confirmation.publicBookingId}`,
    ].join("\n"));
    expect(mail.text).toContain("If you didn't ask for this, you can ignore this email.");
    grantOnlyInFragment(mail);
    expect(linesWith(mail, "Sample Guest")).toEqual(["Hi Sample Guest,"]);
    expect(`${mail.subject}${mail.text}${mail.html}`).not.toMatch(/guest@example\.com/);
    expect(mail.html).not.toMatch(/<img|<script|<link|<style|src=|url\(|@import/i);
  });
});
