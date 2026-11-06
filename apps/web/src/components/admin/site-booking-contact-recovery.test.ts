import { describe, expect, it } from "vitest";
import type { ExperienceSupportCase } from "@niho-experience/experience-store";
import { CONTACT_DELIVERY_LABEL, contactDeliveryText, RECENT_CONTACT_WINDOW_MS, unsettledOwnContact } from "./site-booking-contact-recovery";

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
