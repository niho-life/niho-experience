import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  mock: false,
  supportEnabled: false,
  config: { groupInquiryEnabled: true, nihoWriterEnabled: false } as Record<string, unknown>,
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ get config() { return state.config; } }));
vi.mock("@/lib/host/server", () => ({ isHostMock: () => state.mock }));
vi.mock("@/lib/host/support-settings-server", () => ({ isHostSupportSettingsEnabled: () => state.supportEnabled }));
vi.mock("next/navigation", () => ({ usePathname: () => "/host/home", useRouter: () => ({ push: vi.fn() }) }));

import { HostNoHostGuide, HostRegisterPrompt } from "./HostRegisterPrompt";

const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1]!.replaceAll("&amp;", "&"));

beforeEach(() => {
  state.mock = false;
  state.supportEnabled = false;
  state.config = { groupInquiryEnabled: true, nihoWriterEnabled: false };
});

describe("HostRegisterPrompt (#695)", () => {
  it("against the real API guides to the listing inquiry, with no registration link, no NIHO error and no unusable support link", () => {
    const html = renderToStaticMarkup(createElement(HostRegisterPrompt, { title: "ホーム" }));
    expect(html).toContain("まだどのホストにも属していません");
    expect(html).toContain("体験を載せたいときは、まず相談してください。");
    expect(hrefs(html)).toContain("/ja/inquiry?type=listing&from=listing");
    expect(hrefs(html)).not.toContain("/host/register");
    expect(hrefs(html)).not.toContain("/host/support");
    expect(hrefs(html)).not.toContain("/write");
    expect(html).not.toContain("NIHO に接続できませんでした");
    expect(html).not.toContain("提供者として登録");
  });

  it("shows the writer and support links only where those features are on, and falls back to mail when the inquiry form is closed", () => {
    state.config = { groupInquiryEnabled: false, nihoWriterEnabled: true };
    state.supportEnabled = true;
    const html = renderToStaticMarkup(createElement(HostNoHostGuide, { title: "設定" }));
    expect(hrefs(html)).toContain("/write");
    expect(hrefs(html)).toContain("/host/support");
    expect(hrefs(html).some((href) => href.startsWith("mailto:info@niho.life"))).toBe(true);
    expect(hrefs(html).some((href) => href.includes("/inquiry"))).toBe(false);
  });

  it("keeps the registration prompt in the preview", () => {
    state.mock = true;
    const html = renderToStaticMarkup(createElement(HostRegisterPrompt, { title: "ホーム" }));
    expect(html).toContain("提供者として登録");
    expect(hrefs(html)).toContain("/host/register");
    expect(hrefs(html)).toContain("/host/support");
  });
});
