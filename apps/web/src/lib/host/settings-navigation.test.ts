import { describe, expect, it } from "vitest";
import { hostSettingsIndexGroups, hostSettingsSectionFromHash, hostSettingsSectionOrNull, hostSettingsSectionPath } from "./settings-navigation";

describe("host settings navigation", () => {
  it("accepts only the UI sections and maps every legacy settings hash", () => {
    expect(hostSettingsSectionOrNull("notifications")).toBe("notifications");
    expect(hostSettingsSectionOrNull("all")).toBe("all");
    for (const [hash, section] of [
      ["#settings-payout", "payout"], ["settings-calendar", "calendar"], ["#settings-notification", "notifications"],
      ["#settings-team", "team"], ["#settings-support", "support"], ["#settings-account", "account"],
      ["#settings-device", "device"], ["#settings-meeting", "meeting"],
    ] as const) expect(hostSettingsSectionFromHash(hash), hash).toBe(section);
    expect(hostSettingsSectionOrNull(["provider"])).toBeNull();
    expect(hostSettingsSectionOrNull("unknown")).toBeNull();
    expect(hostSettingsSectionFromHash("#settings-unknown")).toBeNull();
  });

  it("builds section URLs without losing the provider", () => {
    expect(hostSettingsSectionPath("provider:one", "calendar")).toBe("/host/settings?providerId=provider%3Aone&section=calendar");
  });

  it("keeps owner-only rows away from other provider roles", () => {
    const options = { providerId: "provider-one", deviceEnabled: true, articlesEnabled: true };
    const labels = (role: "OWNER" | "EDITOR" | "COHOST" | "VIEWER") => hostSettingsIndexGroups({ ...options, role }).flatMap((group) => group.items.map((item) => item.label));
    expect(labels("OWNER")).toEqual(["提供者情報", "ホスト紹介", "販売者表示", "受取口座", "通知", "カレンダー連携", "チーム", "NIHOサポート", "集合案内", "ログイン情報", "この端末", "記事連携"]);
    expect(labels("EDITOR")).toEqual(["提供者情報", "カレンダー連携", "NIHOサポート", "集合案内", "ログイン情報", "この端末"]);
    expect(labels("COHOST")).toEqual(["カレンダー連携", "NIHOサポート", "ログイン情報", "この端末"]);
    expect(labels("VIEWER")).toEqual(["NIHOサポート", "ログイン情報", "この端末"]);
  });
});
