import { createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** 通知の宛先の確認 (#194): `/host/notification-email#t=<token>`. Synthetic tokens only. */
const state = vi.hoisted(() => ({ config: { hostMailEnabled: false } }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ get config() { return state.config; } }));
vi.mock("@/lib/host/server", () => ({ requireHostConsole: () => {} }));
vi.mock("@/host/actions", () => ({ confirmNotificationAddress: vi.fn() }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NEXT_NOT_FOUND"); } }));

import Page, { metadata } from "@/app/(host)/host/notification-email/page";
import { HostNotificationEmailConfirm, notificationEmailToken } from "./HostNotificationEmailConfirm";

const TOKEN = "Ab3_-".repeat(8) + "xyz";

beforeEach(() => {
  state.config = { hostMailEnabled: false };
});

describe("the notification address confirmation page", () => {
  it("reads only a token of the issued shape from the fragment", () => {
    expect(TOKEN).toHaveLength(43);
    expect(notificationEmailToken(`#t=${TOKEN}`)).toBe(TOKEN);
    for (const hash of ["", "#", `#g=${TOKEN}`, "#t=short", `#t=${TOKEN}a`, `#t=${TOKEN.slice(0, 42)}!`]) expect(notificationEmailToken(hash)).toBeNull();
  });

  it("is not found while this site sends hosts no email, and never indexed or referred", () => {
    expect(() => Page()).toThrow("NEXT_NOT_FOUND");
    state.config = { hostMailEnabled: true };
    expect(isValidElement(Page())).toBe(true);
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(metadata.referrer).toBe("no-referrer");
  });

  it("changes nothing until the button is pressed: the server renders the waiting state only", () => {
    const html = renderToStaticMarkup(createElement(HostNotificationEmailConfirm));
    expect(html).toContain("通知の宛先の確認");
    expect(html).toContain("確認しています…");
    expect(html).not.toContain("切り替えました");
  });
});
