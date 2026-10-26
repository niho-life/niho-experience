import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { openGoogleRefreshToken, sealGoogleRefreshToken } from "./google-token-crypto";

describe("Google refresh token encryption", () => {
  it("round trips only for the same provider and rejects tampering", () => {
    const key = Buffer.alloc(32, 7);
    const sealed = sealGoogleRefreshToken(key, "provider-a", "synthetic-refresh-token");
    expect(openGoogleRefreshToken(key, "provider-a", sealed)).toBe("synthetic-refresh-token");
    expect(() => openGoogleRefreshToken(key, "provider-b", sealed)).toThrow();
    expect(() => openGoogleRefreshToken(key, "provider-a", `${sealed.slice(0, -2)}aa`)).toThrow();
  });
});
