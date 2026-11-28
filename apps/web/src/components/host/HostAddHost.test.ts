import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PROVIDER_REQUIRED_MESSAGE } from "@/lib/host/api-path";
import { addHostState } from "@/lib/host/providers";
import { HostAddHost } from "./HostAddHost";
import { HostErrorMessage } from "./HostProviderRequired";

vi.mock("next/link", () => ({ default: ({ href, children, className }: { href: string; children: unknown; className?: string }) => createElement("a", { href, className }, children as string) }));

const owner = { memberRole: "OWNER" as const };
const render = (count: number, enabled: boolean, extra: Array<{ memberRole: "EDITOR" }> = []) => {
  const state = addHostState([...Array.from({ length: count }, () => owner), ...extra], { enabled, limit: 3 });
  return { state, html: renderToStaticMarkup(createElement(HostAddHost, { state, limit: 3 })) };
};

describe("ホストを追加", () => {
  it("is not offered with the flag off", () => {
    expect(render(1, false)).toEqual({ state: "hidden", html: "" });
  });
  it("leads to the registration below the limit, for none, one and two owned hosts", () => {
    for (const count of [0, 1, 2]) {
      const { state, html } = render(count, true);
      expect(state).toBe("available");
      expect(html).toContain('href="/host/start"');
      expect(html).toContain("ホストを追加");
    }
  });
  it("says the limit instead of a button at three owned hosts; hosts it only belongs to do not count", () => {
    const full = render(3, true);
    expect(full.state).toBe("limit");
    expect(full.html).toContain("ホストは 3 つまでです。");
    expect(full.html).not.toContain("/host/start");
    expect(render(2, true, [{ memberRole: "EDITOR" }]).state).toBe("available");
  });
});

describe("「ホストを選んでください」", () => {
  it("comes with the way to choose a host, other errors do not", () => {
    expect(renderToStaticMarkup(createElement(HostErrorMessage, { text: PROVIDER_REQUIRED_MESSAGE }))).toContain('href="/host/account#account-providers"');
    expect(renderToStaticMarkup(createElement(HostErrorMessage, { text: "保存できませんでした。" }))).not.toContain("href");
  });
});
