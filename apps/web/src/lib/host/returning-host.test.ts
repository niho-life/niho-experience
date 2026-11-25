import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** The returning host's mark (#632): a console page without a session sends a marked browser to the NIHO sign-in by itself. */
const state = vi.hoisted(() => ({
  config: { apiMode: "http", hostAccountsEnabled: true, hostNihoLoginEnabled: true },
  cookies: {} as Record<string, string>,
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: state.config }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (name: string) => (name in state.cookies ? { name, value: state.cookies[name] } : undefined) }) }));

import { autoLoginAllowed, clearReturningHostCookie, markAutoLoginStarted, returningHostLoginPath, setReturningHostCookie } from "./returning-host";
import { AUTO_LOGIN_COOKIE, RETURNING_HOST_COOKIE } from "./session";

beforeEach(() => {
  Object.assign(state.config, { apiMode: "http", hostAccountsEnabled: true, hostNihoLoginEnabled: true });
  state.cookies = {};
});

describe("the returning host", () => {
  it("sends only a marked browser to the automatic sign-in, and only with the NIHO account login on outside the mock", async () => {
    expect(await returningHostLoginPath()).toBeNull();
    state.cookies[RETURNING_HOST_COOKIE] = "1";
    expect(await returningHostLoginPath()).toBe("/host/auth/login?auto=1");
    for (const off of [{ hostNihoLoginEnabled: false }, { hostAccountsEnabled: false }, { apiMode: "mock" }]) {
      Object.assign(state.config, { apiMode: "http", hostAccountsEnabled: true, hostNihoLoginEnabled: true }, off);
      expect(await returningHostLoginPath(), JSON.stringify(off)).toBeNull();
    }
    Object.assign(state.config, { apiMode: "http", hostAccountsEnabled: true, hostNihoLoginEnabled: true });
    state.cookies[RETURNING_HOST_COOKIE] = "someone";
    expect(await returningHostLoginPath()).toBeNull();
  });

  it("allows the automatic sign-in once in the interval", () => {
    expect(autoLoginAllowed(new NextRequest("https://experience.example.test/host/auth/login?auto=1"))).toBe(true);
    expect(autoLoginAllowed(new NextRequest("https://experience.example.test/host/auth/login?auto=1", { headers: { cookie: `${AUTO_LOGIN_COOKIE}=1` } }))).toBe(false);
  });

  it("writes cookies that say nothing about who signed in", () => {
    const response = NextResponse.json({});
    setReturningHostCookie(response);
    markAutoLoginStarted(response);
    expect(response.headers.getSetCookie()).toEqual([
      expect.stringMatching(/^__Host-niho_host_returning=1; Path=\/; .*Max-Age=34560000;.*Secure; HttpOnly; SameSite=lax$/),
      expect.stringMatching(/^__Secure-niho_host_auto_login=1; Path=\/host\/auth; .*Max-Age=120;.*Secure; HttpOnly; SameSite=lax$/),
    ]);
    const cleared = NextResponse.json({});
    clearReturningHostCookie(cleared);
    expect(cleared.headers.getSetCookie()[0]).toMatch(/^__Host-niho_host_returning=; Path=\/; .*Max-Age=0/);
  });
});
