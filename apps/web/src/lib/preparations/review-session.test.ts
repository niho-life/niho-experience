import { describe, expect, it } from "vitest";
import { cookieSealer } from "@/lib/host/cookie-seal";
import { decodePreparationReviewGrant, encodePreparationReviewGrant, PREPARATION_REVIEW_COOKIE, preparationReviewCookieOptions } from "./review-session";

const NOW = Date.parse("2026-10-26T00:00:00.000Z");
const grant = { token: "t".repeat(43), caseId: "case_1", expiresAt: NOW + 60_000 };

describe("sealed preparation review token", () => {
  const sealer = cookieSealer("synthetic-secret-for-review-cookie-0123456789", "experience-preparation-review-token");

  it("round-trips without exposing the token and expires closed", () => {
    const value = encodePreparationReviewGrant(sealer, grant);
    expect(value).not.toContain(grant.token);
    expect(decodePreparationReviewGrant(sealer, value, NOW)).toEqual(grant);
    expect(decodePreparationReviewGrant(sealer, value, grant.expiresAt)).toBeNull();
  });

  it("rejects tampering, invalid case ids and other cookie purposes", () => {
    const value = encodePreparationReviewGrant(sealer, grant);
    expect(decodePreparationReviewGrant(sealer, `${value}x`, NOW)).toBeNull();
    expect(decodePreparationReviewGrant(cookieSealer("synthetic-secret-for-review-cookie-0123456789", "session"), value, NOW)).toBeNull();
    expect(() => encodePreparationReviewGrant(sealer, { ...grant, caseId: "../other" })).toThrow();
  });

  it("uses a host-scoped HttpOnly secure cookie with a bounded age", () => {
    expect(PREPARATION_REVIEW_COOKIE).toMatch(/^__Secure-/);
    expect(preparationReviewCookieOptions(grant.expiresAt, NOW)).toMatchObject({ httpOnly: true, secure: true, sameSite: "lax", path: "/host", maxAge: 60 });
  });
});
