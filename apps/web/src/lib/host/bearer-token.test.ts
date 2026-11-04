import { describe, expect, it } from "vitest";
import { parseBearerToken } from "./bearer-token";

describe("parseBearerToken", () => {
  it("accepts opaque service tokens containing the letter s", () => {
    expect(parseBearerToken("Bearer service-token-123")).toBe("service-token-123");
  });

  it.each([undefined, null, "Basic service-token", "Bearer ", "Bearer token with spaces", "Bearer token\n"]) (
    "rejects an invalid authorization value (%s)", (value) => {
      expect(parseBearerToken(value)).toBeNull();
    },
  );
});
