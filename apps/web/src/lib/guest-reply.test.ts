import { describe, expect, it, vi } from "vitest";
import { openReplyLink, parseReplyLink, sendGuestReply, tokenFromFragment } from "./guest-reply";

const TOKEN = "sample-token-".padEnd(43, "x");
const LINK = {
  experienceTitle: "Synthetic tea",
  hostDisplayName: "Sample Seller",
  guestName: "Sample Guest",
  messages: [
    { from: "guest", atUtc: "2026-10-31T01:00:00.000Z", body: "Is there a vegetarian option?" },
    { from: "host", atUtc: "2026-10-31T02:00:00.000Z", body: "Yes, we can." },
  ],
  expiresAtUtc: "2026-11-14T02:00:00.000Z",
};

describe("the reply page's link", () => {
  it("reads the token from the fragment only", () => {
    expect(tokenFromFragment(`#t=${TOKEN}`)).toBe(TOKEN);
    expect(tokenFromFragment(`t=${TOKEN}`)).toBe(TOKEN);
    expect(tokenFromFragment("#t=short")).toBeNull();
    expect(tokenFromFragment("")).toBeNull();
    expect(tokenFromFragment(`#token=${TOKEN}`)).toBeNull();
  });

  it("keeps the conversation only in its closed shape", () => {
    expect(parseReplyLink({ link: LINK })).toEqual(LINK);
    expect(parseReplyLink({ link: { ...LINK, guestEmail: "guest@example.com" } })).toEqual(LINK);
    expect(parseReplyLink({ link: { ...LINK, messages: [{ from: "admin", atUtc: LINK.expiresAtUtc, body: "x" }] } })).toBeNull();
    expect(parseReplyLink({ link: { ...LINK, guestName: "" } })).toBeNull();
    expect(parseReplyLink(null)).toBeNull();
  });
});

describe("openReplyLink and sendGuestReply", () => {
  it("post the token in the body to this site with a same-origin referrer policy", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ link: LINK }));
    expect(await openReplyLink(TOKEN, fetchImpl)).toEqual({ kind: "open", link: LINK });
    expect(fetchImpl).toHaveBeenCalledWith("/api/public/questions/reply/open", expect.objectContaining({ method: "POST", body: JSON.stringify({ token: TOKEN }), referrerPolicy: "same-origin", credentials: "omit" }));
  });

  it("read a closed link, a used one, an invalid answer and failures", async () => {
    const answering = (status: number) => async () => new Response(null, { status });
    expect(await openReplyLink(TOKEN, answering(404))).toEqual({ kind: "closed" });
    expect(await openReplyLink(TOKEN, answering(503))).toEqual({ kind: "failed" });
    expect(await openReplyLink(TOKEN, async () => { throw new TypeError("offline"); })).toEqual({ kind: "failed" });
    expect(await sendGuestReply(TOKEN, "Thanks", "sample-key-1", answering(201))).toEqual({ kind: "sent" });
    expect(await sendGuestReply(TOKEN, "Thanks", "sample-key-1", answering(404))).toEqual({ kind: "closed" });
    expect(await sendGuestReply(TOKEN, "Thanks", "sample-key-1", answering(409))).toEqual({ kind: "used" });
    expect(await sendGuestReply(TOKEN, "Thanks", "sample-key-1", answering(422))).toEqual({ kind: "invalid" });
    expect(await sendGuestReply(TOKEN, "Thanks", "sample-key-1", answering(500))).toEqual({ kind: "failed" });
  });
});
