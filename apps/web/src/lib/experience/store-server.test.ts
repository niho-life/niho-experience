import { afterEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  apiMode: "mock",
  guestReviewsEnabled: false,
  experiencePublicationsEnabled: false,
  guestReviewOptions: [] as unknown[],
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: {
  get apiMode() { return state.apiMode; },
  get guestReviewsEnabled() { return state.guestReviewsEnabled; },
  get experiencePublicationsEnabled() { return state.experiencePublicationsEnabled; },
} }));
vi.mock("pg", () => ({ Pool: class {} }));
vi.mock("@niho-experience/experience-store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@niho-experience/experience-store")>();
  return { ...original, GuestReviewRepository: class {
    constructor(_pool: unknown, options: unknown) { state.guestReviewOptions.push(options); }
  } };
});

afterEach(() => {
  vi.unstubAllEnvs();
  state.apiMode = "mock";
  state.guestReviewsEnabled = false;
  state.experiencePublicationsEnabled = false;
  state.guestReviewOptions.length = 0;
});

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

it("keeps a booking's messages and the host's site threads closed in the preview even with a database URL (#285 slice 6b)", async () => {
  vi.stubEnv("EXPERIENCE_DATABASE_URL", "postgresql://synthetic:unused@127.0.0.1/unused");
  const { guestBookingMessages, siteThreadRepository } = await import("./store-server");
  expect(guestBookingMessages()).toBeNull();
  expect(siteThreadRepository()).toBeNull();
});

it("keeps guest reviews closed in the preview even with a database URL (#104)", async () => {
  vi.stubEnv("EXPERIENCE_DATABASE_URL", "postgresql://synthetic:unused@127.0.0.1/unused");
  const { guestReviewRepository } = await import("./store-server");
  expect(guestReviewRepository()).toBeNull();
});

it("passes the public publication switch into the guest review public scope", async () => {
  vi.stubEnv("EXPERIENCE_DATABASE_URL", "postgresql://synthetic:unused@127.0.0.1/unused");
  state.apiMode = "http";
  state.guestReviewsEnabled = true;
  const { guestReviewRepository } = await import("./store-server");

  state.experiencePublicationsEnabled = false;
  expect(guestReviewRepository()).not.toBeNull();
  state.experiencePublicationsEnabled = true;
  expect(guestReviewRepository()).not.toBeNull();
  expect(state.guestReviewOptions).toEqual([
    { includeNativePublications: false },
    { includeNativePublications: true },
  ]);
});

it("keeps guest booking closed in the preview even with a database URL (#285)", async () => {
  vi.stubEnv("EXPERIENCE_DATABASE_URL", "postgresql://synthetic:unused@127.0.0.1/unused");
  const { guestBookingRepository } = await import("./store-server");
  expect(guestBookingRepository()).toBeNull();
});
