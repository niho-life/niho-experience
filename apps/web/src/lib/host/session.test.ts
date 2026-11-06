import { describe, expect, it } from "vitest";
import { CookieSealer } from "./cookie-seal";
import {
  COOKIE_BYTES_LIMIT,
  decodeLoginState,
  decodeSession,
  encodeLoginState,
  encodeSession,
  HostSessionTooLargeError,
  accessTokenUsable,
  LOGIN_MAX_AGE_SECONDS,
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  sessionMaxAgeSeconds,
  shouldRefresh,
  startSession,
  nihoSessionOrNull,
  recentlyAuthenticated,
  sessionKeeperExpiresAt,
  sessionUsableInApp,
  type ExperienceHostSession,
  type HostSession,
  type NihoHostSession,
} from "./session";

const sealer = new CookieSealer(["synthetic-test-secret-0123456789abcdefghij"], "session");
const loginSealer = new CookieSealer(["synthetic-test-secret-0123456789abcdefghij"], "login");
const NOW = Date.UTC(2026, 9, 21, 3, 0, 0);
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;

function session(overrides: Partial<NihoHostSession> = {}): NihoHostSession {
  return startSession(
    {
      refreshToken: "synthetic-refresh-token",
      accessToken: "synthetic.web-access-token",
      accessTokenExpiresAt: NOW + 60 * MIN,
      connectionId: "synthetic-connection",
      connectionExpiresAt: NOW + 90 * DAY,
      displayName: "合成 ホスト",
      iconUrl: "https://images.example.test/face.jpg",
      ...overrides,
    },
    NOW,
  );
}

describe("host session cookie", () => {
  it("round-trips the session", () => {
    const value = session();
    expect(decodeSession(sealer, encodeSession(sealer, value), NOW)).toEqual(value);
  });

  it("keeps the app mark (#177) through the cookie and a new sign-in window", () => {
    const app = session({ surface: "app" });
    expect(decodeSession(sealer, encodeSession(sealer, app), NOW)).toEqual(app);
    // A refresh rebuilds the session from the old one; the mark goes with it.
    expect(startSession({ ...app, accessToken: "synthetic.web-access-token.2" }, NOW + DAY).surface).toBe("app");
    expect(decodeSession(sealer, encodeSession(sealer, session()), NOW)).not.toHaveProperty("surface");
  });

  it("rejects old cookies that stored Firebase or synthetic user identity", () => {
    const value = session();
    const oldWire = { v: 2, u: "old-user-id", r: value.refreshToken, t: "old-firebase-id-token", te: value.accessTokenExpiresAt, c: value.connectionId, ce: value.connectionExpiresAt, x: value.expiresAt, n: value.displayName };
    expect(decodeSession(sealer, sealer.seal(oldWire), NOW)).toBeNull();
  });

  it("keeps the session for 30 days from the last sign-in or refresh, never past the connection", () => {
    expect(session().expiresAt).toBe(NOW + SESSION_MAX_AGE_SECONDS * 1000);
    expect(sessionMaxAgeSeconds(session(), NOW)).toBe(SESSION_MAX_AGE_SECONDS);
    expect(session({ connectionExpiresAt: NOW + 2 * DAY }).expiresAt).toBe(NOW + 2 * DAY);
  });

  it("treats an expired session or connection as signed out", () => {
    const sealed = encodeSession(sealer, session({ connectionExpiresAt: NOW + 2 * DAY }));
    expect(decodeSession(sealer, sealed, NOW + 2 * DAY - 1)).not.toBeNull();
    expect(decodeSession(sealer, sealed, NOW + 2 * DAY)).toBeNull();
    const long = encodeSession(sealer, session());
    expect(decodeSession(sealer, long, NOW + 30 * DAY)).toBeNull();
  });

  it("rejects a tampered cookie and a login cookie used as a session", () => {
    const sealed = encodeSession(sealer, session());
    const [version, keyId, data] = sealed.split(".");
    // Change a full byte of the IV; replacing the last base64url character can
    // alter only unused padding bits and leave the decoded cookie unchanged.
    const tampered = `${version}.${keyId}.${data![0] === "A" ? "B" : "A"}${data!.slice(1)}`;
    expect(decodeSession(sealer, tampered, NOW)).toBeNull();
    const login = encodeLoginState(loginSealer, { verifier: "v".repeat(43), state: "s".repeat(43), providerId: null, preparationCaseId: null, expiresAt: NOW + 10 * MIN });
    expect(decodeSession(sealer, login, NOW)).toBeNull();
  });

  it("fits in one 4 KB cookie with realistic NIHO access and refresh tokens", () => {
    const value = session({
      accessToken: `${"h".repeat(36)}.${"p".repeat(1100)}.${"s".repeat(342)}`,
      refreshToken: "r".repeat(128),
      connectionId: "c".repeat(64),
      // The longest name kept (80 characters), all multi-byte.
      displayName: "あ".repeat(80),
      iconUrl: `https://storage.googleapis.com/synthetic-bucket/users/${"x".repeat(440)}.jpg`,
    });
    const sealed = encodeSession(sealer, value);
    expect(Buffer.byteLength(SESSION_COOKIE) + Buffer.byteLength(sealed)).toBeLessThanOrEqual(COOKIE_BYTES_LIMIT);
    expect(decodeSession(sealer, sealed, NOW)?.iconUrl).toBe(value.iconUrl);
  });

  it("drops the face before the tokens, and refuses a session that cannot fit", () => {
    const big = session({ accessToken: "t".repeat(2500), iconUrl: `https://images.example.test/${"x".repeat(990)}` });
    const sealed = encodeSession(sealer, big);
    expect(Buffer.byteLength(SESSION_COOKIE) + Buffer.byteLength(sealed)).toBeLessThanOrEqual(COOKIE_BYTES_LIMIT);
    expect(decodeSession(sealer, sealed, NOW)).toMatchObject({ accessToken: big.accessToken, iconUrl: null });
    expect(() => encodeSession(sealer, session({ accessToken: "t".repeat(4000) }))).toThrow(HostSessionTooLargeError);
  });

  it("keeps only https faces and trims display names", () => {
    const sealed = encodeSession(sealer, session({ iconUrl: "javascript:alert(1)", displayName: "  合成   ホスト  " }));
    expect(decodeSession(sealer, sealed, NOW)).toMatchObject({ iconUrl: null, displayName: "合成 ホスト" });
  });
});

describe("refresh timing", () => {
  it("refreshes only within five minutes of the access token's expiry", () => {
    const value = session({ accessTokenExpiresAt: NOW + 60 * MIN });
    expect(shouldRefresh(value, NOW)).toBe(false);
    expect(shouldRefresh(value, NOW + 55 * MIN - 1)).toBe(false);
    expect(shouldRefresh(value, NOW + 55 * MIN + 1)).toBe(true);
    expect(shouldRefresh(value, NOW + 61 * MIN)).toBe(true);
  });

  it("stops using the access token a minute before it expires", () => {
    const value = session({ accessTokenExpiresAt: NOW + 60 * MIN });
    expect(accessTokenUsable(value, NOW + 58 * MIN)).toBe(true);
    expect(accessTokenUsable(value, NOW + 59 * MIN)).toBe(false);
    expect(accessTokenUsable(value, NOW + 61 * MIN)).toBe(false);
  });
});

describe("login cookie", () => {
  const login = { verifier: "v".repeat(43), state: "s".repeat(43), providerId: "provider_1", preparationCaseId: "case_1", expiresAt: NOW + LOGIN_MAX_AGE_SECONDS * 1000 };

  it("round-trips for 10 minutes", () => {
    const sealed = encodeLoginState(loginSealer, login);
    expect(decodeLoginState(loginSealer, sealed, NOW + 9 * MIN)).toEqual(login);
    expect(decodeLoginState(loginSealer, sealed, NOW + 10 * MIN)).toBeNull();
  });

  it("carries a sign-in started inside the installed app, and nothing for older login cookies", () => {
    const app = { ...login, surface: "app" as const };
    expect(decodeLoginState(loginSealer, encodeLoginState(loginSealer, app), NOW)).toEqual(app);
    expect(decodeLoginState(loginSealer, encodeLoginState(loginSealer, login), NOW)).not.toHaveProperty("surface");
    const older = loginSealer.seal({ v: 1, pv: login.verifier, s: login.state, x: login.expiresAt });
    expect(decodeLoginState(loginSealer, older, NOW)).toEqual({ ...login, providerId: null, preparationCaseId: null });
  });

  it("is not accepted from the session sealer", () => {
    expect(decodeLoginState(sealer, encodeLoginState(loginSealer, login), NOW)).toBeNull();
  });
});

describe("the session union (NIHO login or Experience host account, ADR 0003)", () => {
  const experience: ExperienceHostSession = {
    kind: "experience",
    sessionToken: "s".repeat(43),
    hostAccountId: `hst_${"a".repeat(32)}`,
    email: "synthetic-host@example.test",
    sessionRef: "0f8fad5b-d9cb-469f-a165-70867728950e",
    authenticatedAtUtc: new Date(NOW - 10 * MIN).toISOString(),
    idleExpiresAtUtc: new Date(NOW + 14 * DAY).toISOString(),
    absoluteExpiresAtUtc: new Date(NOW + 20 * DAY).toISOString(),
    displayName: "synthetic-host@example.test",
    iconUrl: null,
  };

  it("marks every NIHO session it builds or opens, older cookies included", () => {
    expect(session().kind).toBe("niho");
    expect(decodeSession(sealer, encodeSession(sealer, session()), NOW)?.kind).toBe("niho");
  });

  it("uses an Experience session as the store read it: no access token to expire, usable in the app", () => {
    expect(accessTokenUsable(experience, NOW + 365 * DAY)).toBe(true);
    expect(sessionUsableInApp(experience)).toBe(true);
    expect(sessionUsableInApp(session())).toBe(false);
    expect(sessionUsableInApp(session({ surface: "app" }))).toBe(true);
  });

  it("lets only a NIHO session reach code that sends NIHO's token", () => {
    const sessions: HostSession[] = [session(), experience];
    expect(sessions.map((value) => nihoSessionOrNull(value)?.accessToken ?? null)).toEqual(["synthetic.web-access-token", null]);
    expect(nihoSessionOrNull(null)).toBeNull();
    const either: HostSession = experience;
    // @ts-expect-error An Experience session has no NIHO token: what takes NIHO sessions (the cookie, NIHO's clients) refuses it.
    const refused: Parameters<typeof encodeSession>[1] = either;
    expect(refused.kind).toBe("experience");
    if (either.kind === "experience") {
      // @ts-expect-error Narrowed to the Experience session: no accessToken property exists.
      expect(either.accessToken).toBeUndefined();
      expect(either.hostAccountId).toMatch(/^hst_/);
    }
  });

  it("tells the keeper the access token's expiry or the idle end, whichever session it is", () => {
    expect(sessionKeeperExpiresAt(session())).toBe(NOW + 60 * MIN);
    expect(sessionKeeperExpiresAt(experience)).toBe(NOW + 14 * DAY);
    // Near the absolute end, the idle end is capped by it.
    expect(sessionKeeperExpiresAt({ ...experience, idleExpiresAtUtc: new Date(NOW + 3 * DAY).toISOString(), absoluteExpiresAtUtc: new Date(NOW + 2 * DAY).toISOString() })).toBe(NOW + 2 * DAY);
  });

  it("asks for a sign-in within the given minutes before a sensitive change", () => {
    expect(recentlyAuthenticated(experience, NOW, 30)).toBe(true);
    expect(recentlyAuthenticated(experience, NOW + 20 * MIN, 30)).toBe(true);
    expect(recentlyAuthenticated(experience, NOW + 21 * MIN, 30)).toBe(false);
    expect(recentlyAuthenticated({ ...experience, authenticatedAtUtc: "not a time" }, NOW, 30)).toBe(false);
  });
});
