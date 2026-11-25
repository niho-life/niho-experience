import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/** 設定 › 通知 with its 宛先 (#109, #194). Synthetic addresses only. */
vi.mock("@/host/actions", () => ({ requestNotificationAddress: vi.fn(), restoreLoginNotificationAddress: vi.fn(), cancelNotificationAddress: vi.fn() }));

import { NOTIFICATION_ADDRESS_TEXT, type HostNotificationAddressView } from "@/host/notification-address";
import { notificationPanelView } from "@/host/notifications";
import { HostNotificationPanel } from "./HostNotificationPanel";

const settings = { email: { addresses: ["kitchen@example.com"] }, items: [] };
const live = (view: Partial<HostNotificationAddressView> = {}): HostNotificationAddressView => ({
  effective: "login@example.test", source: "login", login: "login@example.test", pending: null, preview: false, ...view,
});
const render = (role: "OWNER" | "EDITOR", address: HostNotificationAddressView | "error" | null) => {
  const view = notificationPanelView(role === "OWNER" ? settings : null, role, "live");
  const rows = view.kind === "owner" ? view.rows : [];
  return renderToStaticMarkup(createElement(HostNotificationPanel, { view, rows, onToggle: () => {}, providerId: "provider-a", address }))
    .replace(/<!-- -->/g, "");
};

describe("設定 › 通知 › 宛先", () => {
  it("keeps NIHO's read-only address while this site sends no host email", () => {
    const html = render("OWNER", null);
    expect(html).toContain("kitchen@example.com");
    expect(html).toContain("宛先の変更は準備中です");
    expect(html).not.toContain("宛先を変える");
    // Anyone but the owner: one line, as before.
    expect(render("EDITOR", null)).not.toContain("宛先");
  });

  it("points everyone to their account for the address, the switches staying the owner's", () => {
    const owner = render("OWNER", live());
    expect(owner).toContain("宛先は、あなたのアカウントで変えられます。");
    expect(owner).toContain('href="/host/account?providerId=provider-a"');
    expect(owner).toContain("アカウント設定");
    for (const gone of ["login@example.test", "宛先を変える", "kitchen@example.com", "宛先の変更は準備中です"]) expect(owner).not.toContain(gone);
    expect(owner).toContain("新しい予約・申込");
    const editor = render("EDITOR", live({ effective: "desk@example.test", source: "chosen" }));
    expect(editor).toContain("宛先は、あなたのアカウントで変えられます。");
    expect(editor).not.toContain("desk@example.test");
    expect(editor).not.toContain("ログインのメールに戻す");
    // The owner's switches stay out of reach.
    expect(editor).toContain("通知の設定はオーナーが変えられます");
    expect(editor).not.toContain("新しい予約・申込");
  });

  it("says when the address could not be read", () => {
    const failed = render("OWNER", "error");
    expect(failed).toMatch(new RegExp(`role="alert"[^>]*>${NOTIFICATION_ADDRESS_TEXT.loadFailed}`));
  });
});
