import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ resolveContext: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/experience/calendar-actor", () => ({ resolveCalendarContext: state.resolveContext }));
vi.mock("@/lib/config", () => ({ config: { nihoHostStartUrl: "https://niho.example/host", nihoWebOrigin: "https://niho.example" } }));
vi.mock("@/lib/safe-url", () => ({ safeNihoProviderUrl: () => null }));
vi.mock("@/components/host/HostRegisterPrompt", () => ({ HostRegisterPrompt: () => createElement("div") }));
vi.mock("@/components/host/ui", () => ({ HostPageBody: ({ children }: { children: ReactNode }) => createElement("main", null, children) }));
vi.mock("@/components/host/HostCalendarWorkspace", () => ({
  HostCalendarWorkspace: ({ initialExperienceId }: { initialExperienceId: string | null }) =>
    createElement("div", { "data-initial-experience-id": initialExperienceId ?? "none" }),
}));

import HostCalendarPage from "./page";

beforeEach(() => {
  state.resolveContext.mockResolvedValue({ choice: { kind: "MEMBER", id: "provider-a" }, providerNotFound: false });
});

describe("host calendar product entry", () => {
  it("passes a valid product ID to the calendar workspace", async () => {
    const id = "00000000-0000-4000-8000-000000000369";
    const markup = renderToStaticMarkup(await HostCalendarPage({ searchParams: Promise.resolve({ experience: id }) }));
    expect(markup).toContain(`data-initial-experience-id="${id}"`);
  });

  it("ignores malformed and repeated product IDs", async () => {
    for (const experience of ["../../other", ["one", "two"], " "]) {
      const markup = renderToStaticMarkup(await HostCalendarPage({ searchParams: Promise.resolve({ experience }) }));
      expect(markup).toContain('data-initial-experience-id="none"');
    }
  });
});
