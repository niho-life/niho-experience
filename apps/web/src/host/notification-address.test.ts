import { describe, expect, it } from "vitest";
import { NOTIFICATION_ADDRESS_TEXT, notificationAddressInput, notificationAddressSourceText, notificationAddressView, previewNotificationAddress } from "./notification-address";

/** 設定 › 通知 › 宛先 (#194). Synthetic addresses only. */
describe("the notification address", () => {
  it("takes a typed address trimmed, and nothing of another shape", () => {
    expect(notificationAddressInput("  desk@example.test ")).toBe("desk@example.test");
    for (const value of [null, 1, "", "desk", "desk@", "@example.test", "a b@example.test", "a@b", `${"a".repeat(250)}@example.test`]) {
      expect(notificationAddressInput(value)).toBeNull();
    }
  });

  it("says where the emails go and why: a chosen address, the sign-in's, or none yet", () => {
    const chosen = notificationAddressView({ loginEmail: "login@example.test", overrideEmail: "desk@example.test", effectiveEmail: "desk@example.test", pendingEmail: null });
    expect(chosen).toEqual({ effective: "desk@example.test", source: "chosen", login: "login@example.test", pending: null, preview: false });
    expect(notificationAddressSourceText(chosen)).toBe(NOTIFICATION_ADDRESS_TEXT.chosen);
    const login = notificationAddressView({ loginEmail: "login@example.test", overrideEmail: null, effectiveEmail: "login@example.test", pendingEmail: "new@example.test" });
    expect([login.source, login.pending, notificationAddressSourceText(login)]).toEqual(["login", "new@example.test", NOTIFICATION_ADDRESS_TEXT.login]);
    const none = notificationAddressView({ loginEmail: null, overrideEmail: null, effectiveEmail: null, pendingEmail: null });
    expect([none.effective, none.source, notificationAddressSourceText(none)]).toEqual([null, null, NOTIFICATION_ADDRESS_TEXT.none]);
    expect(previewNotificationAddress("kitchen@example.com")).toEqual({ effective: "kitchen@example.com", source: "login", login: "kitchen@example.com", pending: null, preview: true });
    expect(NOTIFICATION_ADDRESS_TEXT.pending("new@example.test")).toContain("1 時間有効");
  });
});
