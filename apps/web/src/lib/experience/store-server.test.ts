import { afterEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ apiMode: "mock" }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: { get apiMode() { return state.apiMode; } } }));
vi.mock("pg", () => ({ Pool: class { constructor() { throw new Error("Preview must not initialize a database pool"); } } }));

afterEach(() => { vi.unstubAllEnvs(); state.apiMode = "mock"; });

it("never gives a mock NIHO identity access to the operator database", async () => {
  vi.stubEnv("EXPERIENCE_DATABASE_URL", "postgresql://synthetic:unused@127.0.0.1/unused");
  const { productOperatorRepository } = await import("./store-server");
  expect(productOperatorRepository()).toBeNull();
});

it("enables typed Google/Airbnb acceptance only in HTTP mode with both dedicated flags", async () => {
  const { googleAirbnbObservationEnabled } = await import("./store-server");
  state.apiMode = "http";
  vi.stubEnv("EXPERIENCE_AIRBNB_GOOGLE_OBSERVATION_ENABLED", "true");
  vi.stubEnv("EXPERIENCE_AIRBNB_GOOGLE_DELIVERY_ENABLED", "false");
  expect(googleAirbnbObservationEnabled()).toBe(false);
  vi.stubEnv("EXPERIENCE_AIRBNB_GOOGLE_DELIVERY_ENABLED", "true");
  expect(googleAirbnbObservationEnabled()).toBe(true);
  state.apiMode = "mock";
  expect(googleAirbnbObservationEnabled()).toBe(false);
});

it("keeps guest questions closed in the preview even with a database URL", async () => {
  vi.stubEnv("EXPERIENCE_DATABASE_URL", "postgresql://synthetic:unused@127.0.0.1/unused");
  const { guestQuestionRepository } = await import("./store-server");
  expect(guestQuestionRepository()).toBeNull();
});
