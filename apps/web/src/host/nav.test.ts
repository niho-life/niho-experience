import { describe, expect, it } from "vitest";
import { HOST_NAV, withProvider, withQuery } from "@/lib/host/routes";
import { hostBackLink, isHostNavActive, providerSwitchPath } from "./nav";

const selected = (location: string) => HOST_NAV.filter((item) => isHostNavActive(location, item.href)).map((item) => item.label);

describe("host navigation", () => {
  it("lists the five destinations in order", () => {
    expect(HOST_NAV.map((item) => item.label)).toEqual(["ホーム", "体験", "予約", "売上", "設定"]);
  });

  it("selects exactly one item on each top page", () => {
    expect(selected("/host/home")).toEqual(["ホーム"]);
    expect(selected("/host/home/")).toEqual(["ホーム"]);
    expect(selected("/host/experiences")).toEqual(["体験"]);
    expect(selected("/host/bookings")).toEqual(["予約"]);
    expect(selected("/host/sales")).toEqual(["売上"]);
    expect(selected("/host/settings/")).toEqual(["設定"]);
  });

  it("ignores ?providerId= and other queries on either side", () => {
    expect(selected("/host/bookings?providerId=sample-provider-studio")).toEqual(["予約"]);
    expect(selected("/host/home?providerId=sample-provider-kitchen#todo")).toEqual(["ホーム"]);
    expect(selected("/host/experiences/coffee?providerId=sample-provider-kitchen")).toEqual(["体験"]);
    expect(isHostNavActive("/host/settings", "/host/settings?providerId=sample-provider-studio")).toBe(true);
  });

  it("keeps the parent selected on sub pages and never matches by bare prefix", () => {
    expect(selected("/host/experiences/community-dinner")).toEqual(["体験"]);
    // この回 (#107) is a screen under 予約.
    expect(selected("/host/bookings/session?providerId=sample-provider-kitchen&date=2026-10-22&start=18%3A00")).toEqual(["予約"]);
    // メッセージ is a screen under ホーム (#106), not a menu item of its own.
    expect(selected("/host/messages")).toEqual(["ホーム"]);
    expect(selected("/host/messages/?providerId=sample-provider-kitchen&thread=th-3012")).toEqual(["ホーム"]);
    // So is レビュー (#108).
    expect(selected("/host/reviews?providerId=sample-provider-kitchen&experience=community-dinner#review-rv-5020")).toEqual(["ホーム"]);
    expect(selected("/host/messages-archive")).toEqual([]);
    expect(selected("/host/reviewsx")).toEqual([]);
    expect(selected("/host/experiences-archive")).toEqual([]);
    expect(selected("/host/homework")).toEqual([]);
    expect(selected("/host/register")).toEqual([]);
    expect(selected("/host")).toEqual([]);
    expect(selected("/experiences")).toEqual([]);
  });

  it("gives sub pages a back link and top pages none", () => {
    expect(hostBackLink("/host/experiences/community-dinner")).toEqual({ href: "/host/experiences", label: "体験" });
    expect(hostBackLink("/host/experiences/community-dinner/?providerId=sample-provider-kitchen")).toEqual({ href: "/host/experiences", label: "体験" });
    expect(hostBackLink("/host/bookings/session", "date=2026-10-22&start=18%3A00&experience=community-dinner&offer=offer-dinner")).toEqual({ href: "/host/bookings", label: "予約" });
    for (const path of ["/host", "/host/home", "/host/experiences", "/host/experiences?providerId=x", "/host/settings", "/host/register"]) expect(hostBackLink(path), path).toBeNull();
  });

  it("gives one booking (?booking=) the way back to 予約, from the location or from the page's query", () => {
    const bookings = { href: "/host/bookings", label: "予約" };
    expect(hostBackLink("/host/bookings?booking=bk-2041")).toEqual(bookings);
    expect(hostBackLink("/host/bookings", "providerId=sample-provider-kitchen&filter=pending&booking=bk-2041")).toEqual(bookings);
    expect(hostBackLink("/host/bookings/", new URLSearchParams({ booking: "bk-2041" }))).toEqual(bookings);
    // The query given wins over the one written in the location.
    expect(hostBackLink("/host/bookings?booking=bk-2041", "")).toBeNull();
    for (const [path, search] of [["/host/bookings", ""], ["/host/bookings", "filter=pending"], ["/host/bookings", "booking="], ["/host/home", "booking=bk-2041"], ["/host/sales", "booking=bk-2041"]] as const) {
      expect(hostBackLink(path, search), `${path}?${search}`).toBeNull();
    }
  });

  it("leads メッセージ back to ホーム, and one thread (?thread= or a booking's ?booking=) back to メッセージ", () => {
    const home = { href: "/host/home", label: "ホーム" };
    const messages = { href: "/host/messages", label: "メッセージ" };
    expect(hostBackLink("/host/messages")).toEqual(home);
    expect(hostBackLink("/host/messages", "providerId=sample-provider-kitchen")).toEqual(home);
    expect(hostBackLink("/host/messages?thread=th-3012")).toEqual(messages);
    expect(hostBackLink("/host/messages", "booking=bk-2044")).toEqual(messages);
    expect(hostBackLink("/host/messages", "thread=")).toEqual(home);
  });

  it("leads レビュー back to ホーム, whatever experience or review it shows", () => {
    const home = { href: "/host/home", label: "ホーム" };
    expect(hostBackLink("/host/reviews")).toEqual(home);
    expect(hostBackLink("/host/reviews", "providerId=sample-provider-kitchen&experience=community-dinner")).toEqual(home);
    expect(hostBackLink("/host/reviews#review-rv-5020")).toEqual(home);
    expect(providerSwitchPath("/host/reviews")).toBe("/host/reviews");
  });

  it("switches the provider on the same page, or on the section of a page under it", () => {
    expect(providerSwitchPath("/host/messages")).toBe("/host/messages");
    expect(providerSwitchPath("/host/bookings/")).toBe("/host/bookings");
    expect(providerSwitchPath("/host/experiences/community-dinner")).toBe("/host/experiences");
    // Another provider may have no such session: its list.
    expect(providerSwitchPath("/host/bookings/session")).toBe("/host/bookings");
    expect(providerSwitchPath("/host/home")).toBe("/host/home");
  });

  it("adds a page's own query and the provider to a link", () => {
    expect(withProvider("/host/home", "sample-provider-studio")).toBe("/host/home?providerId=sample-provider-studio");
    expect(withProvider("/host/home", null)).toBe("/host/home");
    expect(withProvider("/host/bookings?filter=pending", "sample-provider-studio")).toBe("/host/bookings?filter=pending&providerId=sample-provider-studio");
    expect(withQuery("/host/bookings", { filter: null, booking: "bk 1&2" })).toBe("/host/bookings?booking=bk+1%262");
    expect(withQuery("/host/bookings?booking=a", { booking: "b" })).toBe("/host/bookings?booking=b");
    // A hash (one review, #108) stays at the end.
    expect(withProvider("/host/reviews#review-rv-5020", "sample-provider-kitchen")).toBe("/host/reviews?providerId=sample-provider-kitchen#review-rv-5020");
    expect(withQuery("/host/reviews?experience=a#review-x", { providerId: "p" })).toBe("/host/reviews?experience=a&providerId=p#review-x");
    expect(withProvider("/host/reviews#review-x", null)).toBe("/host/reviews#review-x");
  });
});
