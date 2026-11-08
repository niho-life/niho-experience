import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { openGoogleRefreshToken, sealGoogleRefreshToken } from "./google-token-crypto";

describe("Google refresh token encryption", () => {
  it("round trips only for the same provider and rejects tampering", () => {
    const key = Buffer.alloc(32, 7);
    const sealed = sealGoogleRefreshToken(key, "provider-a", "synthetic-refresh-token");
    expect(openGoogleRefreshToken(key, "provider-a", sealed)).toBe("synthetic-refresh-token");
    expect(() => openGoogleRefreshToken(key, "provider-b", sealed)).toThrow();
    // Mutate a decoded byte: replacing base64url characters can preserve the
    // original tag because its final character contains unused padding bits.
    const parts = sealed.split(".");
    const tag = Buffer.from(parts[3]!, "base64url");
    tag[0] = tag[0]! ^ 1;
    parts[3] = tag.toString("base64url");
    expect(() => openGoogleRefreshToken(key, "provider-a", parts.join("."))).toThrow();
  });
});
