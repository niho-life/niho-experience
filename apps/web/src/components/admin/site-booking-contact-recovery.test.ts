import { describe, expect, it } from "vitest";
import type { ExperienceSupportCase } from "@niho-experience/experience-store";
import { CONTACT_DELIVERY_LABEL, contactDeliveryText, RECENT_CONTACT_WINDOW_MS, unsettledOwnContact, withRefreshedEvents } from "./site-booking-contact-recovery";

type CaseEvent = ExperienceSupportCase["events"][number];

const NOW = Date.parse("2026-11-06T10:00:00.000Z");
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const event = (patch: Partial<CaseEvent> = {}): CaseEvent => ({
  type: "GUEST_CONTACT_SENT", revision: 1, actorAdminUserId: "admin-1", occurredAtUtc: minutesAgo(2), action: null, outcome: null,
  commandId: "0b1f6a52-7a4e-4f0a-9d8e-3c5c1d2e4a10", delivery: "PENDING", ...patch,
});

describe("a contact the Admin made, seen again after the screen was opened anew", () => {
  it("names every delivery state, and says when it cannot be known", () => {
    expect(contactDeliveryText({ delivery: "PENDING" })).toBe(CONTACT_DELIVERY_LABEL.PENDING);
    expect(contactDeliveryText({ delivery: "SENDING" })).toBe(CONTACT_DELIVERY_LABEL.SENDING);
    expect(contactDeliveryText({ delivery: "SENT" })).toBe(CONTACT_DELIVERY_LABEL.SENT);
    expect(contactDeliveryText({ delivery: "FAILED" })).toBe(CONTACT_DELIVERY_LABEL.FAILED);
    expect(contactDeliveryText({ delivery: null })).toBe("送信状態を確認できません");
    // A server that does not send the state yet.
    expect(contactDeliveryText({} as Pick<CaseEvent, "delivery">)).toBe("送信状態を確認できません");
  });

  it("reminds the Admin of their own recent contact that is not sent: waiting, sending, failed, or not known", () => {
    for (const delivery of ["PENDING", "SENDING", "FAILED", null] as const) {
      expect(unsettledOwnContact([event({ delivery })], "admin-1", NOW)?.delivery, String(delivery)).toBe(delivery);
    }
  });

  it("does not remind of a contact that was sent, one by another Admin, an old one, or another kind of event", () => {
    expect(unsettledOwnContact([event({ delivery: "SENT" })], "admin-1", NOW)).toBeNull();
    expect(unsettledOwnContact([event({ actorAdminUserId: "admin-2" })], "admin-1", NOW)).toBeNull();
    expect(unsettledOwnContact([event({ occurredAtUtc: new Date(NOW - RECENT_CONTACT_WINDOW_MS - 1).toISOString() })], "admin-1", NOW)).toBeNull();
    expect(unsettledOwnContact([event({ type: "SUPPORT_ACTION", delivery: null, action: "SUPPORT_CANCEL", outcome: "CANCELLED" })], "admin-1", NOW)).toBeNull();
    expect(unsettledOwnContact([], "admin-1", NOW)).toBeNull();
  });

  it("keeps the boundary: exactly at the window still counts, and a server clock a little ahead is tolerated", () => {
    expect(unsettledOwnContact([event({ occurredAtUtc: new Date(NOW - RECENT_CONTACT_WINDOW_MS).toISOString() })], "admin-1", NOW)).not.toBeNull();
    expect(unsettledOwnContact([event({ occurredAtUtc: new Date(NOW + 30_000).toISOString() })], "admin-1", NOW)).not.toBeNull();
    expect(unsettledOwnContact([event({ occurredAtUtc: new Date(NOW + 5 * 60_000).toISOString() })], "admin-1", NOW)).toBeNull();
    expect(unsettledOwnContact([event({ occurredAtUtc: "not a date" })], "admin-1", NOW)).toBeNull();
  });

  it("needs to know who the Admin is, and picks the newest event of the list", () => {
    expect(unsettledOwnContact([event()], null, NOW)).toBeNull();
    const newest = event({ revision: 3, delivery: "FAILED" });
    expect(unsettledOwnContact([newest, event({ revision: 2, delivery: "PENDING" })], "admin-1", NOW)).toBe(newest);
    // A sent contact does not hide an older one that is still waiting.
    const waiting = event({ revision: 2, delivery: "PENDING" });
    expect(unsettledOwnContact([event({ revision: 3, delivery: "SENT" }), waiting], "admin-1", NOW)).toBe(waiting);
  });
});

describe("checking where an email is while the case is being edited", () => {
  const screen = (patch: Partial<ExperienceSupportCase> = {}): ExperienceSupportCase => ({
    publicBookingId: "0b1f6a52-7a4e-4f0a-9d8e-3c5c1d2e4a99", assignedAdminUserId: "admin-1", internalMemo: "Saved memo", revision: 4,
    updatedBy: "admin-1", updatedAtUtc: minutesAgo(10), events: [event({ delivery: "PENDING" })], ...patch,
  });

  it("takes the history from the fresh read and keeps the revision, the assignee and the memo the screen holds", () => {
    const current = screen();
    // Meanwhile the mail job sent the email, and another Admin changed the memo (revision 5).
    const fresh = screen({ revision: 5, internalMemo: "Another Admin's memo", assignedAdminUserId: "admin-2", events: [event({ delivery: "SENT" })] });
    const merged = withRefreshedEvents(current, fresh);
    expect(merged.events).toEqual([event({ delivery: "SENT" })]);
    expect([merged.revision, merged.internalMemo, merged.assignedAdminUserId]).toEqual([4, "Saved memo", "admin-1"]);
    // The screen's case is not changed in place.
    expect(current.events[0]?.delivery).toBe("PENDING");
  });

  it("changes nothing when the fresh read has no case", () => {
    const current = screen();
    expect(withRefreshedEvents(current, null)).toBe(current);
  });
});
