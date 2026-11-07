import { describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

vi.mock("server-only", () => ({}));
vi.mock("react", async (importOriginal) => ({ ...(await importOriginal<typeof import("react")>()), cache: <T>(value: T) => value }));
vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("next/navigation", () => ({ notFound: vi.fn() }));
vi.mock("@/lib/config", () => ({ config: {
  hostSessionSecret: "synthetic-writer-session-secret-0123456789abcdef",
  apiMode: "http",
  siteUrl: "https://experience.example.test",
  hostConsoleEnabled: true,
  hostAccountsEnabled: false,
} }));

import { setSessionCookie } from "@/lib/host/server";
import { SESSION_COOKIE, startSession } from "@/lib/host/session";

describe("writer session cookie migration", () => {
  it("writes one live Path=/ rotating session and expires the old Path=/host copy", () => {
    const now = Date.now();
    const session = startSession({
      refreshToken: "refresh",
      accessToken: "access",
      accessTokenExpiresAt: now + 60_000,
      connectionId: "connection",
      connectionExpiresAt: now + 3_600_000,
      displayName: "Synthetic",
      iconUrl: null,
    }, now);
    const response = new NextResponse(null, { status: 204 });
    setSessionCookie(response, session, now);
    const cookies = response.headers.getSetCookie().filter((header) => header.startsWith(`${SESSION_COOKIE}=`));
    expect(cookies).toHaveLength(2);
    expect(cookies.filter((header) => /Path=\/(?:;|$)/.test(header) && !/Max-Age=0/.test(header))).toHaveLength(1);
    expect(cookies.filter((header) => /Path=\/host(?:;|$)/.test(header) && /Max-Age=0/.test(header))).toHaveLength(1);
  });
});
