import { describe, expect, it } from "vitest";
import { CookieSealer } from "@/lib/host/cookie-seal";
import { encodeAdminSession, startAdminSession } from "@/admin/session";
import { encodeSession, startSession } from "@/lib/host/session";
import {
  ADMIN_HTTP_ABSOLUTE_MAX_AGE_MS,
  decodeAdminHttpSession,
  encodeAdminHttpSession,
  startAdminHttpSession,
} from "./http-session";

describe("Admin HTTP session", () => {
  const secret = "a".repeat(40);
  const admin = new CookieSealer([secret], "admin-http-session");

  function session(now = 1_000) {
    return startAdminHttpSession({
      refreshToken: "refresh-token",
      idToken: "id-token",
      idTokenExpiresAt: now + 60 * 60 * 1000,
      connectionId: "connection-1",
      exchangedConnectionExpiresAt: now + 12 * 60 * 60 * 1000,
      verifiedConnectionExpiresAt: now + 10 * 60 * 60 * 1000,
      actorId: "admin-1",
      actorName: "Admin One",
    }, now)!;
  }

  it("caps the absolute lifetime at 8 hours and never accepts it at the deadline", () => {
    const now = 1_000;
    const value = session(now);
    expect(value.connectionExpiresAt).toBe(now + ADMIN_HTTP_ABSOLUTE_MAX_AGE_MS);
    const sealed = encodeAdminHttpSession(admin, value);
    expect(decodeAdminHttpSession(admin, sealed, value.connectionExpiresAt - 1)).toEqual(value);
    expect(decodeAdminHttpSession(admin, sealed, value.connectionExpiresAt)).toBeNull();
  });

  it("binds the cookie to Admin HTTP purpose, client and mode", () => {
    const value = session();
    const sealed = encodeAdminHttpSession(admin, value);
    expect(decodeAdminHttpSession(new CookieSealer([secret], "session"), sealed, 1_001)).toBeNull();
    expect(decodeAdminHttpSession(new CookieSealer([secret], "admin-preview-session"), sealed, 1_001)).toBeNull();

    const host = startSession({
      nihoUserId: "synthetic-host-user",
      refreshToken: "host-refresh",
      idToken: "host-token",
      idTokenExpiresAt: 60_000,
      connectionId: "host-connection",
      connectionExpiresAt: 90_000,
      displayName: "Host",
      iconUrl: null,
    }, 1_000);
    const hostCookie = encodeSession(new CookieSealer([secret], "session"), host);
    expect(decodeAdminHttpSession(admin, hostCookie, 1_001)).toBeNull();

    const previewCookie = encodeAdminSession(new CookieSealer([secret], "admin-preview-session"), startAdminSession("preview-session-1", 1_000));
    expect(decodeAdminHttpSession(admin, previewCookie, 1_001)).toBeNull();
  });

  it("keeps tokens only inside the sealed value", () => {
    const sealed = encodeAdminHttpSession(admin, session());
    expect(sealed).not.toContain("refresh-token");
    expect(sealed).not.toContain("id-token");
    expect(sealed).not.toContain("Admin One");
  });
});
