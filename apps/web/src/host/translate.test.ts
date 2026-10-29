import { describe, expect, it } from "vitest";
import type { ExperienceTranslateRoomCreatedResponse, ExperienceTranslateRoomStatusResponse } from "@niho-experience/api-client/experience-translate-rooms";
import { guestNeedsInterpretation, participantStatus, projectTranslateRoom, projectTranslateRoomStatus, timeInJapan, translationOffered } from "./translate";

const created = {
  roomId: "room_1", state: "created", expiresAt: "2026-11-08T01:15:00.000Z",
  host: { participantId: "participant_host", inviteCode: "host-code-secret", inviteUrl: "https://app-stg.niho.test/i/host-code-secret" },
  guest: { participantId: "participant_guest", inviteCode: "guest-code-secret", inviteUrl: "https://app-stg.niho.test/i/guest-code-secret" },
} satisfies ExperienceTranslateRoomCreatedResponse;

describe("translate room DTOs", () => {
  it("gives the browser the invite URLs and nothing that names a participant or a code on its own", () => {
    const projected = projectTranslateRoom(created);
    expect(projected).toEqual({ room: { id: "room_1", state: "created", expiresAt: "2026-11-08T01:15:00.000Z", hostInviteUrl: created.host.inviteUrl, guestInviteUrl: created.guest.inviteUrl } });
    const text = JSON.stringify(projected);
    expect(text).not.toContain("participant_");
    expect(text).not.toContain("inviteCode");
  });

  it("turns the participants list into host and guest, missing roles not joined", () => {
    const status = { state: "active", participants: [{ role: "host", joined: true, ready: true }], usageMinutes: 4 } satisfies ExperienceTranslateRoomStatusResponse;
    expect(projectTranslateRoomStatus(status)).toEqual({ state: "active", host: { joined: true, ready: true }, guest: { joined: false, ready: false }, usageMinutes: 4 });
  });
});

describe("通訳を始める display rule", () => {
  it("is offered on a confirmed booking of an English-speaking (or unrecorded) guest from today on", () => {
    expect(translationOffered({ confirmed: true, language: "EN", date: "2026-10-22" }, "2026-10-21")).toBe(true);
    expect(translationOffered({ confirmed: true, language: "en", date: "2026-10-21" }, "2026-10-21")).toBe(true);
    expect(translationOffered({ confirmed: true, language: "", date: "2026-10-21" }, "2026-10-21")).toBe(true);
    expect(translationOffered({ confirmed: true, language: "ja", date: "2026-10-22" }, "2026-10-21")).toBe(false);
    expect(translationOffered({ confirmed: false, language: "en", date: "2026-10-22" }, "2026-10-21")).toBe(false);
    expect(translationOffered({ confirmed: true, language: "en", date: "2026-10-20" }, "2026-10-21")).toBe(false);
    expect(guestNeedsInterpretation("en-GB")).toBe(true);
    expect(guestNeedsInterpretation("JA")).toBe(false);
  });

  it("says who has joined in words, not only in color", () => {
    expect(participantStatus(undefined)).toEqual({ label: "未参加", tone: "draft" });
    expect(participantStatus({ joined: true, ready: false })).toEqual({ label: "接続中 · 準備中", tone: "wait" });
    expect(participantStatus({ joined: true, ready: true })).toEqual({ label: "接続中", tone: "ok" });
  });

  it("writes the invite expiry as a time in Japan", () => {
    expect(timeInJapan("2026-11-08T01:15:00.000Z")).toBe("10:15");
    expect(timeInJapan("not a date")).toBe("");
  });
});
