import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ mock: false, consent: null as null | { version: string; text: string } }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: { groupInquiryEnabled: true, nihoWriterEnabled: false } }));
vi.mock("@/lib/host/server", () => ({ isHostMock: () => state.mock }));
vi.mock("@/lib/host/support-settings-server", () => ({ isHostSupportSettingsEnabled: () => false }));
vi.mock("@/host/data", () => ({ loadRegistrationConsent: async () => state.consent }));
vi.mock("@/components/host/HostRegisterForm", () => ({ HostRegisterForm: () => createElement("form", null, "register-form") }));
vi.mock("next/navigation", () => ({ usePathname: () => "/host/register", useRouter: () => ({ push: vi.fn() }) }));

import HostRegisterPage from "./page";

beforeEach(() => { state.mock = false; state.consent = null; });

describe("/host/register (#695)", () => {
  it("against the real API shows the inquiry guidance instead of NIHO's error", async () => {
    const html = renderToStaticMarkup(await HostRegisterPage());
    expect(html).toContain("まだどのホストにも属していません");
    expect(html).toContain("/ja/inquiry?type=listing&amp;from=listing");
    expect(html).not.toContain("提供者規約を読み込めませんでした");
    expect(html).not.toContain("NIHO に接続できませんでした");
  });

  it("keeps the registration form in the preview", async () => {
    state.mock = true;
    state.consent = { version: "v1", text: "terms" };
    expect(renderToStaticMarkup(await HostRegisterPage())).toContain("register-form");
  });
});
