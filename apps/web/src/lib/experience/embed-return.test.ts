import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The return page's "Back to {host}" link (#638): read from the booking of the Checkout Session, never from the URL. */
const state = vi.hoisted(() => ({
  config: { embedEnabled: true, guestBookingEnabled: true },
  repository: null as null | { findEmbedReturnOrigin: ReturnType<typeof vi.fn> },
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ get config() { return state.config; } }));
vi.mock("@/lib/experience/store-server", () => ({ guestBookingRepository: () => state.repository }));

import { EMBED_RETURN_LOOKUP_TIMEOUT_MS, embedReturnLink } from "./embed-return";

const SESSION = "cs_test_synthetic1";

afterEach(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  state.config = { embedEnabled: true, guestBookingEnabled: true };
  state.repository = { findEmbedReturnOrigin: vi.fn(async () => "https://host-site.example.test") };
});

describe("embedReturnLink", () => {
  it("links to the origin kept with the booking of that Session", async () => {
    expect(await embedReturnLink(SESSION)).toEqual({ href: "https://host-site.example.test", host: "host-site.example.test" });
    expect(state.repository?.findEmbedReturnOrigin).toHaveBeenCalledWith(SESSION);
    state.repository!.findEmbedReturnOrigin.mockResolvedValueOnce("https://host-site.example.test:8443");
    expect(await embedReturnLink(SESSION)).toEqual({ href: "https://host-site.example.test:8443", host: "host-site.example.test:8443" });
  });

  it("reads nothing while the widget or guest bookings are off, or without one cs", async () => {
    for (const config of [{ embedEnabled: false, guestBookingEnabled: true }, { embedEnabled: true, guestBookingEnabled: false }]) {
      state.config = config;
      expect(await embedReturnLink(SESSION)).toBeUndefined();
    }
    state.config = { embedEnabled: true, guestBookingEnabled: true };
    expect(await embedReturnLink(undefined)).toBeUndefined();
    expect(await embedReturnLink([SESSION, SESSION])).toBeUndefined();
    expect(state.repository?.findEmbedReturnOrigin).not.toHaveBeenCalled();
  });

  it("has no link when the store has none, is unavailable or fails", async () => {
    state.repository!.findEmbedReturnOrigin.mockResolvedValueOnce(null);
    expect(await embedReturnLink("cs_test_unknown")).toBeUndefined();
    state.repository!.findEmbedReturnOrigin.mockRejectedValueOnce(new Error("synthetic outage"));
    expect(await embedReturnLink(SESSION)).toBeUndefined();
    state.repository = null;
    expect(await embedReturnLink(SESSION)).toBeUndefined();
  });

  it("does not ask the store about a cs that is not a Checkout Session ID", async () => {
    for (const cs of ["", "https://evil.example.test", "cs_", "cs_test-x", "pi_test_synthetic1", "{CHECKOUT_SESSION_ID}", `cs_${"a".repeat(251)}`]) {
      expect(await embedReturnLink(cs), cs).toBeUndefined();
    }
    expect(state.repository?.findEmbedReturnOrigin).not.toHaveBeenCalled();
  });

  it("gives up after 1.5 seconds and clears its timer", async () => {
    vi.useFakeTimers();
    state.repository!.findEmbedReturnOrigin.mockReturnValueOnce(new Promise(() => undefined));
    const pending = embedReturnLink(SESSION);
    await vi.advanceTimersByTimeAsync(EMBED_RETURN_LOOKUP_TIMEOUT_MS);
    expect(await pending).toBeUndefined();
    expect(EMBED_RETURN_LOOKUP_TIMEOUT_MS).toBe(1_500);
    // A quick answer leaves no timer behind.
    expect(await embedReturnLink(SESSION)).toEqual({ href: "https://host-site.example.test", host: "host-site.example.test" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("links to nothing that is not an https origin", async () => {
    for (const stored of ["http://host-site.example.test", "https://host-site.example.test/path", "javascript:alert(1)", "not a url"]) {
      state.repository!.findEmbedReturnOrigin.mockResolvedValueOnce(stored);
      expect(await embedReturnLink(SESSION), stored).toBeUndefined();
    }
  });
});
