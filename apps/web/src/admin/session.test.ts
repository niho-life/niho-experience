import { describe, expect, it } from "vitest";
import { CookieSealer } from "@/lib/host/cookie-seal";
import { decodeAdminSession, encodeAdminSession, startAdminSession } from "./session";

describe("admin preview session", () => {
  const admin = new CookieSealer(["a".repeat(40)], "admin-preview-session");
  const host = new CookieSealer(["a".repeat(40)], "session");

  it("is sealed for the admin purpose and expires", () => {
    const session = startAdminSession("preview-session-123", 1000);
    const value = encodeAdminSession(admin, session);
    expect(decodeAdminSession(admin, value, 1001)).toEqual(session);
    expect(decodeAdminSession(host, value, 1001)).toBeNull();
    expect(decodeAdminSession(admin, value, session.expiresAt)).toBeNull();
  });
});

