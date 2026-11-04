import { afterEach, describe, expect, it, vi } from "vitest";
import { standaloneInviteExpiryDelay, standaloneInviteUsable, standaloneLanguageLabel, standaloneParticipant, standaloneResponseIsCurrent, standaloneTranslateBffPath, standaloneTranslateErrorText } from "./standalone-translate";

const room = {
  roomId: "room_1", state: "waiting" as const, hostLanguage: "ja" as const, guestLanguage: "en" as const,
  expiresAt: "2026-11-04T02:30:00.000Z", participants: [{ role: "host" as const, joined: true, ready: false }], usageMinutes: 0,
};

describe("standalone translate browser rules", () => {
  afterEach(() => vi.useRealTimers());
  it("keeps local provider ids in the BFF path and labels only the fixed language pair", () => {
    expect(standaloneTranslateBffPath("local/provider")).toBe("translate/standalone/providers/local%2Fprovider/rooms");
    expect(standaloneLanguageLabel("ja")).toBe("日本語");
    expect(standaloneLanguageLabel("en")).toBe("English");
  });

  it("describes create 404 as provider availability, not an ended room", () => {
    expect(standaloneTranslateErrorText(404, "create")).toBe("この提供者ではまだ通訳を利用できません。");
    expect(standaloneTranslateErrorText(404, "end")).toBe("この通訳はすでに終了しています。");
  });

  it("distinguishes invite expiry from the room and defaults a missing participant to not joined", () => {
    expect(standaloneInviteUsable({ inviteUrl: `https://app.niho.life/t#${"x".repeat(43)}`, expiresAt: "2026-11-04T01:15:00.000Z" }, Date.parse("2026-11-04T01:14:59.000Z"))).toBe(true);
    expect(standaloneInviteUsable({ inviteUrl: `https://app.niho.life/t#${"x".repeat(43)}`, expiresAt: "2026-11-04T01:15:00.000Z" }, Date.parse("2026-11-04T01:15:00.000Z"))).toBe(false);
    expect(standaloneParticipant(room, "host")).toEqual({ joined: true, ready: false });
    expect(standaloneParticipant(room, "guest")).toEqual({ joined: false, ready: false });
  });

  it("expires an invite on its own timer even when status polling cannot re-render", async () => {
    const expiresAt = "2026-11-04T01:15:00.000Z";
    vi.useFakeTimers({ now: Date.parse("2026-11-04T01:14:59.000Z") });
    const invite = { inviteUrl: `https://app.niho.life/t#${"x".repeat(43)}`, expiresAt };
    let visible = standaloneInviteUsable(invite, Date.now());
    const delay = standaloneInviteExpiryDelay([invite], Date.now());
    expect(delay).toBe(1001);
    setTimeout(() => { visible = standaloneInviteUsable(invite, Date.now()); }, delay!);
    await vi.advanceTimersByTimeAsync(1000);
    expect(visible).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(visible).toBe(false);
  });

  it("rejects late responses after provider generation or room changes", () => {
    expect(standaloneResponseIsCurrent(4, 4, "room_1", "room_1")).toBe(true);
    expect(standaloneResponseIsCurrent(3, 4, "room_1", "room_1")).toBe(false);
    expect(standaloneResponseIsCurrent(4, 4, "room_1", "room_2")).toBe(false);
    expect(standaloneResponseIsCurrent(4, 4, "room_1", null)).toBe(false);
  });

  it("caps distant deadlines to the browser timer limit", () => {
    expect(standaloneInviteExpiryDelay([{ inviteUrl: "https://app.niho.life/t#synthetic", expiresAt: "2099-11-04T01:15:00.000Z" }], 0)).toBe(2_147_483_647);
  });
});
