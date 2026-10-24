import { describe, expect, it } from "vitest";
import { isHostNavigationForm } from "./HostLeaveGuard";

describe("host leave form boundary", () => {
  it("guards only explicit navigation forms", () => {
    const form = (navigation: boolean) => ({ hasAttribute: (name: string) => name === "data-niho-navigation-form" && navigation });
    expect(isHostNavigationForm(form(true))).toBe(true);
    expect(isHostNavigationForm(form(false))).toBe(false);
  });
});
