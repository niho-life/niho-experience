import { afterEach, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: { apiMode: "mock" } }));
vi.mock("pg", () => ({ Pool: class { constructor() { throw new Error("Preview must not initialize a database pool"); } } }));

afterEach(() => vi.unstubAllEnvs());

it("never gives a mock NIHO identity access to the operator database", async () => {
  vi.stubEnv("EXPERIENCE_DATABASE_URL", "postgresql://synthetic:unused@127.0.0.1/unused");
  const { productOperatorRepository } = await import("./store-server");
  expect(productOperatorRepository()).toBeNull();
});

it("keeps guest questions closed in the preview even with a database URL", async () => {
  vi.stubEnv("EXPERIENCE_DATABASE_URL", "postgresql://synthetic:unused@127.0.0.1/unused");
  const { guestQuestionRepository } = await import("./store-server");
  expect(guestQuestionRepository()).toBeNull();
});
