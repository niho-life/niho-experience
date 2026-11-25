import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AnalyticsSetup } from "@/components/Analytics";
import { setAnalyticsSink, track } from "./analytics";

const effects = vi.hoisted(() => ({ cleanups: [] as (() => void)[] }));
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(), useEffect: (effect: () => void | (() => void)) => {
  const cleanup = effect();
  if (cleanup) effects.cleanups.push(cleanup);
} }));

const websiteId = "123e4567-e89b-12d3-a456-426614174000";
let load: () => void;
let dnt = "0";
beforeEach(() => {
  dnt = "0";
  vi.stubGlobal("navigator", { get doNotTrack() { return dnt; } });
  vi.stubGlobal("window", { location: { origin: "https://travel.niho.life", href: "https://travel.niho.life/experiences?utm_source=niho&q=private" } });
  vi.stubGlobal("document", {
    getElementById: () => null,
    createElement: () => ({ dataset: {}, addEventListener: (_event: string, callback: () => void) => { load = callback; } }),
    head: { appendChild: vi.fn() },
  });
});
afterEach(() => { effects.cleanups.splice(0).forEach((cleanup) => cleanup()); setAnalyticsSink(null); vi.unstubAllGlobals(); });

it("queued events keep their original sanitized route when the script loads on another page", () => {
  AnalyticsSetup({ mode: "umami", websiteId });
  track("list_view", { theme: "all" });
  window.location.href = "https://travel.niho.life/experiences/dinner/book?token=private";
  const sent: unknown[] = [];
  window.umami = { track: vi.fn((build?: unknown) => {
    expect(typeof build).toBe("function");
    const raw = (build as (props: Record<string, unknown>) => Record<string, unknown>)({ website: websiteId, title: "private", id: "private" });
    sent.push(window.nihoUmamiBeforeSend?.("event", raw));
    return Promise.resolve();
  }) };
  load();
  expect(sent).toEqual([{ url: "/experiences?utm_source=niho", hostname: "travel.niho.life", title: "Experiences", website: websiteId, name: "list_view", data: { theme: "all" } }]);
});

it("rechecks DNT at send time and discards queued events when DNT changes", () => {
  AnalyticsSetup({ mode: "umami", websiteId });
  track("list_view", { theme: "all" });
  dnt = "1";
  expect(window.nihoUmamiBeforeSend?.("event", { url: "/experiences" })).toBe(false);
  const send = vi.fn().mockResolvedValue(undefined);
  window.umami = { track: send };
  load();
  track("checkout_start", { experience: "dinner" });
  expect(send).not.toHaveBeenCalled();
  dnt = "0";
  load();
  expect(send).not.toHaveBeenCalled();
});
