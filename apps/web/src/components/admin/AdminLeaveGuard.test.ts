import { describe, expect, it } from "vitest";
import { AdminLeaveProtectionRegistry } from "./AdminLeaveGuard";

describe("AdminLeaveProtectionRegistry", () => {
  it("ORs independent case and operations consumers", () => {
    const registry = new AdminLeaveProtectionRegistry();
    expect(registry.set("case", { dirty: true, saving: false })).toEqual({ dirty: true, saving: false });
    expect(registry.set("operations", { dirty: false, saving: true })).toEqual({ dirty: true, saving: true });
    expect(registry.set("case", { dirty: false, saving: false })).toEqual({ dirty: false, saving: true });
  });
  it("removes only the unmounted consumer and reset clears all", () => {
    const registry = new AdminLeaveProtectionRegistry(); registry.set("case", { dirty: true, saving: false }); registry.set("operations", { dirty: true, saving: true });
    expect(registry.delete("case")).toEqual({ dirty: true, saving: true }); expect(registry.reset()).toEqual({ dirty: false, saving: false });
  });
});
