import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  enabled: true,
  context: { provider: { id: "local_provider_1", displayName: "合成の提供者", memberRole: "OWNER" }, providerNotFound: false } as Record<string, unknown> | null,
}));
vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NEXT_NOT_FOUND"); } }));
vi.mock("@/host/data", () => ({ hostPageContext: async () => state.context }));
vi.mock("@/lib/host/translate-rooms-server", () => ({ translateRoomsEnabled: () => state.enabled }));
vi.mock("@/components/host/HostStandaloneTranslate", () => ({ HostStandaloneTranslate: ({ providerId, providerName }: { providerId: string; providerName: string }) => createElement("div", { "data-provider-id": providerId }, providerName) }));

import HostStandaloneTranslatePage from "./page";

describe("standalone translate page authorization", () => {
  beforeEach(() => {
    state.enabled = true;
    state.context = { provider: { id: "local_provider_1", displayName: "合成の提供者", memberRole: "OWNER" }, providerNotFound: false };
  });

  it("renders only the selected current OWNER and passes the local provider id to the browser", async () => {
    const html = renderToStaticMarkup(await HostStandaloneTranslatePage({ searchParams: Promise.resolve({ providerId: "local_provider_1" }) }));
    expect(html).toContain("対面通訳");
    expect(html).toContain('data-provider-id="local_provider_1"');
    expect(html).toContain("合成の提供者");
  });

  it.each(["COHOST", "EDITOR", "VIEWER"])("returns not found for %s", async (memberRole) => {
    state.context = { provider: { id: "local_provider_1", displayName: "合成の提供者", memberRole }, providerNotFound: false };
    await expect(HostStandaloneTranslatePage({ searchParams: Promise.resolve({}) })).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("fails closed for a missing selection or disabled translate runtime", async () => {
    state.context = { provider: { id: "local_provider_1", displayName: "合成の提供者", memberRole: "OWNER" }, providerNotFound: true };
    await expect(HostStandaloneTranslatePage({ searchParams: Promise.resolve({}) })).rejects.toThrow("NEXT_NOT_FOUND");
    state.context = { provider: { id: "local_provider_1", displayName: "合成の提供者", memberRole: "OWNER" }, providerNotFound: false };
    state.enabled = false;
    await expect(HostStandaloneTranslatePage({ searchParams: Promise.resolve({}) })).rejects.toThrow("NEXT_NOT_FOUND");
  });
});
