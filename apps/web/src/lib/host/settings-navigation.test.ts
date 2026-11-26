import { describe, expect, it } from "vitest";
import { hostSettingsForwardPath, hostSettingsIndexGroups, hostSettingsSectionFromHash, hostSettingsSectionOrNull, hostSettingsSectionPath } from "./settings-navigation";

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

  it("groups the rows by what they are for and keeps owner-only rows away from other roles", () => {
    const options = { providerId: "provider-one", articlesEnabled: true };
    const rows = (role: "OWNER" | "EDITOR" | "COHOST" | "VIEWER") => hostSettingsIndexGroups({ ...options, role }).map((group) => [group.label, group.items.map((item) => item.label)]);
    expect(rows("OWNER")).toEqual([
      ["掲載", ["提供者情報", "ホスト紹介"]],
      ["販売", ["販売者表示", "受取口座", "NIHOサポート"]],
      ["運営", ["カレンダー連携", "集合案内", "通知の種類", "メンバー", "記事連携"]],
    ]);
    expect(rows("EDITOR")).toEqual([
      ["掲載", ["提供者情報"]],
      ["販売", ["NIHOサポート"]],
      ["運営", ["カレンダー連携", "集合案内", "通知の種類"]],
    ]);
    for (const role of ["COHOST", "VIEWER"] as const) {
      expect(rows(role), role).toEqual([["販売", ["NIHOサポート"]], ["運営", ["カレンダー連携", "通知の種類"]]]);
    }
    expect(hostSettingsIndexGroups({ ...options, role: "OWNER", articlesEnabled: false }).flatMap((group) => group.items.map((item) => item.label))).not.toContain("記事連携");
    // The person's own settings and the team are not in the provider's list.
    const all = hostSettingsIndexGroups({ ...options, role: "OWNER" }).flatMap((group) => group.items.map((item) => item.label));
    for (const gone of ["ログイン情報", "この端末", "チーム", "通知"]) expect(all).not.toContain(gone);
    const members = hostSettingsIndexGroups({ ...options, role: "OWNER" }).flatMap((group) => group.items).find((item) => item.label === "メンバー");
    expect(members).toMatchObject({ href: "/host/members?providerId=provider-one" });
  });

  it("forwards the old account, device and team sections to their new screens", () => {
    expect(hostSettingsForwardPath({ section: "account", providerId: "provider-one", niho: "linked" })).toBe("/host/account?providerId=provider-one&niho=linked");
    expect(hostSettingsForwardPath({ section: "account", providerId: ["provider-one", "x"], niho: ["unlinked"], other: "1" })).toBe("/host/account?providerId=provider-one&niho=unlinked");
    expect(hostSettingsForwardPath({ section: "account" })).toBe("/host/account");
    // Unknown outcomes and malformed provider ids are dropped.
    expect(hostSettingsForwardPath({ section: "account", providerId: "a b/c", niho: "evil" })).toBe("/host/account");
    expect(hostSettingsForwardPath({ section: "device", providerId: "provider-one", niho: "linked" })).toBe("/host/account?providerId=provider-one#account-device");
    expect(hostSettingsForwardPath({ section: "device" })).toBe("/host/account#account-device");
    expect(hostSettingsForwardPath({ section: "team", providerId: "provider-one", niho: "linked" })).toBe("/host/members?providerId=provider-one");
    for (const section of [undefined, "provider", "notifications", "all", "unknown", ["account"]]) expect(hostSettingsForwardPath({ section, providerId: "provider-one" }), String(section)).toBeNull();
  });
});
