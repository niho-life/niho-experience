import { describe, expect, it } from "vitest";
import { GET as login } from "@/app/(editor)/editor/auth/login/route";
import { GET as callback } from "@/app/(editor)/editor/auth/callback/route";
import { POST as refresh } from "@/app/(editor)/editor/auth/refresh/route";
import { POST as logout } from "@/app/(editor)/editor/auth/logout/route";

describe("retired Experience editor authentication", () => {
  it.each([
    ["login", () => login()],
    ["callback", () => callback()],
    ["refresh", () => refresh()],
    ["logout", () => logout()],
  ])("returns 410 without redirects or cookie mutations: %s", async (_name, call) => {
    const response = call();
    expect(response.status).toBe(410);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.json()).toEqual({ error: "gone" });
  });
});
