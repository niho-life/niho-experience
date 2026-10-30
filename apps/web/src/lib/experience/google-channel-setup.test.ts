import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ config: { apiMode: "http", hostConsoleEnabled: true } }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: state.config }));

import { googleChannelSetupDto, googleChannelSetupEnabled } from "./google-channel-setup";

const original = process.env.EXPERIENCE_AIRBNB_GOOGLE_SETUP_ENABLED;
afterEach(() => {
  state.config.apiMode = "http"; state.config.hostConsoleEnabled = true;
  if (original === undefined) delete process.env.EXPERIENCE_AIRBNB_GOOGLE_SETUP_ENABLED;
  else process.env.EXPERIENCE_AIRBNB_GOOGLE_SETUP_ENABLED = original;
});

describe("Google channel setup server boundary", () => {
  it("is false by default and never opens in mock mode", () => {
    delete process.env.EXPERIENCE_AIRBNB_GOOGLE_SETUP_ENABLED;
    expect(googleChannelSetupEnabled()).toBe(false);
    process.env.EXPERIENCE_AIRBNB_GOOGLE_SETUP_ENABLED = "true";
    state.config.apiMode = "mock";
    expect(googleChannelSetupEnabled()).toBe(false);
    state.config.apiMode = "http";
    state.config.hostConsoleEnabled = false;
    expect(googleChannelSetupEnabled()).toBe(false);
  });

  it("returns only the OWNER-safe selected fields", () => {
    expect(googleChannelSetupDto({
      commandId: "command", listingId: "listing", state: "READY_FOR_CONNECTION", calendarName: "name",
      calendarId: "secret", operationNonce: "secret", encryptedRefreshToken: "secret",
    } as never)).toEqual({ commandId: "command", listingId: "listing", state: "READY_FOR_CONNECTION", calendarName: "name" });
  });
});
