import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { hostReturnPathOrNull } from "@/lib/host/routes";

const state = vi.hoisted(() => ({
  session: null as null | { readonly usable: boolean },
  renewal: { outcome: "rejected" } as { readonly outcome: string; readonly session?: { readonly usable: boolean } },
  setSession: vi.fn(),
  clearSession: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: { hostConsoleEnabled: true, hostAccountsEnabled: false } }));
vi.mock("@/lib/host/session", () => ({
  SESSION_COOKIE: "__Secure-niho_host_session",
  decodeSession: () => state.session,
  accessTokenUsable: (session: { readonly usable: boolean }) => session.usable,
}));
vi.mock("@/lib/host/server", () => ({
  hostNotFound: () => NextResponse.json({ error: "not_found" }, { status: 404 }),
  sessionSealer: () => ({}),
  renewSession: () => state.renewal,
  seeOther: (location: string) => new NextResponse(null, { status: 303, headers: { location } }),
  setSessionCookie: state.setSession,
  clearSessionCookie: state.clearSession,
}));

import { GET as bridge } from "@/app/(host)/host/auth/write-bridge/route";

beforeEach(() => {
  vi.clearAllMocks();
  state.session = null;
  state.renewal = { outcome: "rejected" };
});

describe("writer return allowlist", () => {
  it.each([
    ["/write", "/write"],
    ["/write/new?experience=morning-walk", "/write/new?experience=morning-walk"],
    ["/write/article_1", "/write/article_1"],
    ["/write/article_1/preview", "/write/article_1/preview"],
  ])("allows %s", (value, expected) => expect(hostReturnPathOrNull(value)).toBe(expected));

  it.each([
    "https://evil.example/write",
    "//evil.example/write",
    "/write/new?experience=UPPER",
    "/write/new?experience=one&experience=two",
    "/write/article/extra",
    "/write/article_1?next=https://evil.example",
    "/write/article_1/preview#secret",
  ])("rejects %s", (value) => expect(hostReturnPathOrNull(value)).toBeNull());
});

describe("/host/auth/write-bridge", () => {
  it("sends a signed-out browser to login with only an allowlisted return", async () => {
    const response = await bridge(new NextRequest("https://experience.example.test/host/auth/write-bridge?returnTo=https://evil.example/write"));
    expect(response.headers.get("location")).toBe("/host/auth/login?returnTo=%2Fwrite");
    expect(state.clearSession).toHaveBeenCalledOnce();
  });

  it("migrates a usable old /host session without refreshing it", async () => {
    state.session = { usable: true };
    const response = await bridge(new NextRequest("https://experience.example.test/host/auth/write-bridge?returnTo=%2Fwrite%2Fnew%3Fexperience%3Dtea", { headers: { cookie: "__Secure-niho_host_session=sealed" } }));
    expect(response.headers.get("location")).toBe("/write/new?experience=tea");
    expect(state.setSession).toHaveBeenCalledOnce();
  });

  it("clears a rejected rotating session and does not reveal an article", async () => {
    state.session = { usable: false };
    state.renewal = { outcome: "rejected" };
    const response = await bridge(new NextRequest("https://experience.example.test/host/auth/write-bridge?returnTo=%2Fwrite%2Fprivate-article"));
    expect(response.headers.get("location")).toBe("/host/auth/login?returnTo=%2Fwrite%2Fprivate-article");
    expect(state.clearSession).toHaveBeenCalledOnce();
  });

  it("preserves the returned rotating token pair but shows only a generic unavailable error", async () => {
    state.session = { usable: false };
    state.renewal = { outcome: "unavailable", session: { usable: false } };
    const response = await bridge(new NextRequest("https://experience.example.test/host/auth/write-bridge?returnTo=%2Fwrite%2Fprivate-article"));
    expect(response.headers.get("location")).toBe("/host/auth/error?reason=unavailable");
    expect(state.setSession).toHaveBeenCalledOnce();
  });
});
