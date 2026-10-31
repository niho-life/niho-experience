import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ setupEnabled: true }));
vi.mock("server-only", () => ({}));
vi.mock("./google-channel-setup", () => ({ googleChannelSetupEnabled: () => mocks.setupEnabled }));

import { googleChannelActivationEnabled } from "./google-channel-activation";

const original = process.env.EXPERIENCE_AIRBNB_GOOGLE_ACTIVATION_ENABLED;
afterEach(() => {
  mocks.setupEnabled = true;
  if (original === undefined) delete process.env.EXPERIENCE_AIRBNB_GOOGLE_ACTIVATION_ENABLED;
  else process.env.EXPERIENCE_AIRBNB_GOOGLE_ACTIVATION_ENABLED = original;
});

describe("Google channel activation gate", () => {
  it("requires both the existing setup gate and the dedicated explicit flag", () => {
    delete process.env.EXPERIENCE_AIRBNB_GOOGLE_ACTIVATION_ENABLED;
    expect(googleChannelActivationEnabled()).toBe(false);
    process.env.EXPERIENCE_AIRBNB_GOOGLE_ACTIVATION_ENABLED = "true";
    mocks.setupEnabled = false;
    expect(googleChannelActivationEnabled()).toBe(false);
    mocks.setupEnabled = true;
    expect(googleChannelActivationEnabled()).toBe(true);
    process.env.EXPERIENCE_AIRBNB_GOOGLE_ACTIVATION_ENABLED = "TRUE";
    expect(googleChannelActivationEnabled()).toBe(false);
  });
});
