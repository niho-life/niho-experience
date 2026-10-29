import { describe, expect, it } from "vitest";
import { CookieSealer, cookieSealer, splitSecrets } from "./cookie-seal";

const OLD = "old-synthetic-test-secret-0123456789abcdef";
const NEW = "new-synthetic-test-secret-0123456789abcdef";

function flipCharacter(value: string, index: number): string {
  const chars = value.split("");
  chars[index] = chars[index] === "A" ? "B" : "A";
  return chars.join("");
}

describe("host cookie sealing", () => {
  it("round-trips a payload and hides its content", () => {
    const sealer = new CookieSealer([NEW], "session");
    const sealed = sealer.seal({ token: "synthetic-token" });
    expect(sealed).toMatch(/^v1\.[A-Za-z0-9_-]{8}\.[A-Za-z0-9_-]+$/);
    expect(sealed).not.toContain("synthetic-token");
    expect(sealer.open(sealed)).toEqual({ token: "synthetic-token" });
  });

  it("uses a fresh IV for every value", () => {
    const sealer = new CookieSealer([NEW], "session");
    expect(sealer.seal({ a: 1 })).not.toBe(sealer.seal({ a: 1 }));
  });

  it("rejects tampered, truncated or malformed values", () => {
    const sealer = new CookieSealer([NEW], "session");
    const sealed = sealer.seal({ token: "synthetic-token" });
    const data = sealed.lastIndexOf(".") + 1;
    expect(sealer.open(flipCharacter(sealed, data + 5))).toBeNull();
    expect(sealer.open(flipCharacter(sealed, sealed.length - 3))).toBeNull();
    expect(sealer.open(sealed.slice(0, -4))).toBeNull();
    expect(sealer.open(sealed.replace(/^v1\./, "v2."))).toBeNull();
    expect(sealer.open(`${sealed}.extra`)).toBeNull();
    expect(sealer.open("")).toBeNull();
    expect(sealer.open(undefined)).toBeNull();
    expect(sealer.open("v1.short.AAAA")).toBeNull();
  });

  it("never opens a value sealed for another purpose or with another key", () => {
    const login = new CookieSealer([NEW], "login").seal({ state: "x" });
    expect(new CookieSealer([NEW], "session").open(login)).toBeNull();
    expect(new CookieSealer([OLD], "login").open(login)).toBeNull();
    const invitation = new CookieSealer([NEW], "product-operator-invitation").seal({ invitationId: "synthetic", token: "secret" });
    expect(new CookieSealer([NEW], "session").open(invitation)).toBeNull();
    expect(new CookieSealer([NEW], "login").open(invitation)).toBeNull();
  });

  it("rotates keys: the first secret seals, every listed secret opens", () => {
    const before = new CookieSealer([OLD], "session").seal({ n: 1 });
    const rotating = new CookieSealer([NEW, OLD], "session");
    expect(rotating.open(before)).toEqual({ n: 1 });
    const after = rotating.seal({ n: 2 });
    expect(new CookieSealer([NEW], "session").open(after)).toEqual({ n: 2 });
    expect(new CookieSealer([NEW], "session").open(before)).toBeNull();
  });

  it("reads comma-separated secrets and reuses sealers", () => {
    expect(splitSecrets(` ${NEW} , ${OLD},,`)).toEqual([NEW, OLD]);
    expect(cookieSealer(NEW, "session")).toBe(cookieSealer(NEW, "session"));
    expect(() => new CookieSealer([], "session")).toThrow();
  });
});
