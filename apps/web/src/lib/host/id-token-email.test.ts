import { describe, expect, it } from "vitest";
import { verifiedEmailFromIdToken } from "./id-token-email";

/** ホストへのメールの宛先 (#194): the verified address of a Firebase ID token's own user. Synthetic tokens only. */
const token = (claims: unknown) => `${Buffer.from('{"alg":"RS256","kid":"synthetic"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.c2lnbmF0dXJl`;

describe("verifiedEmailFromIdToken", () => {
  it("reads the address only when Firebase marked it verified, for the user the exchange named", () => {
    expect(verifiedEmailFromIdToken(token({ sub: "u1", email: " Host@Example.test ", email_verified: true }), "u1")).toBe("Host@Example.test");
    expect(verifiedEmailFromIdToken(token({ sub: "u1", email: "host@example.test", email_verified: false }), "u1")).toBeNull();
    expect(verifiedEmailFromIdToken(token({ sub: "u1", email: "host@example.test", email_verified: "true" }), "u1")).toBeNull();
    expect(verifiedEmailFromIdToken(token({ sub: "u1", email: "host@example.test" }), "u1")).toBeNull();
    expect(verifiedEmailFromIdToken(token({ sub: "u1", email_verified: true }), "u1")).toBeNull();
    expect(verifiedEmailFromIdToken(token({ sub: "u2", email: "host@example.test", email_verified: true }), "u1")).toBeNull();
    expect(verifiedEmailFromIdToken(token({ user_id: "u1", email: "host@example.test", email_verified: true }), "u1")).toBeNull();
  });

  it("refuses what is not a token or not an address", () => {
    for (const value of ["", "a.b", "a.b.c.d", "a.%%%.c", `a.${Buffer.from("[1,2]").toString("base64url")}.c`, `a.${"x".repeat(20_000)}.c`]) {
      expect(verifiedEmailFromIdToken(value, "u1")).toBeNull();
    }
    for (const email of ["no-at-sign", "two@@example.test", "a b@example.test", "a@b", `${"a".repeat(250)}@example.test`, "line\n@example.test"]) {
      expect(verifiedEmailFromIdToken(token({ sub: "u1", email, email_verified: true }), "u1")).toBeNull();
    }
  });
});
