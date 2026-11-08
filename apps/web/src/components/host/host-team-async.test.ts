import { describe, expect, it } from "vitest";
import { HostTeamAsyncGate } from "./host-team-async";

describe("native team async scope", () => {
  it("rejects delayed list/resolve/mutation results after provider switch", () => {
    const gate = new HostTeamAsyncGate();
    gate.activate("provider-a:OWNER");
    const list = gate.begin("list"); const resolve = gate.begin("resolve"); const command = gate.begin("command");
    gate.activate("provider-b:OWNER");
    expect(gate.current(list)).toBe(false); expect(gate.current(resolve)).toBe(false); expect(gate.current(command)).toBe(false);
    expect(gate.current(gate.begin("list"))).toBe(true);
  });

  it("invalidates only an edited lookup without leaving list or command requests busy forever", () => {
    const gate = new HostTeamAsyncGate(); gate.activate("provider-a:OWNER");
    const command = gate.begin("command"); const list = gate.begin("list"); const lookup = gate.begin("resolve");
    gate.invalidate("resolve");
    expect(gate.current(lookup)).toBe(false);
    expect(gate.current(list)).toBe(true);
    expect(gate.current(command)).toBe(true);
    expect(gate.current(gate.begin("resolve"))).toBe(true);
  });

  it("invalidates an older list and lookup before a membership command can succeed", () => {
    const gate = new HostTeamAsyncGate(); gate.activate("provider-a:OWNER");
    const list = gate.begin("list"); const lookup = gate.begin("resolve");
    const command = gate.begin("command");
    expect(gate.current(list)).toBe(false);
    expect(gate.current(lookup)).toBe(false);
    expect(gate.current(command)).toBe(true);
  });

  it("clears every pending request when permission ends or the component unmounts", () => {
    const gate = new HostTeamAsyncGate(); gate.activate("provider-a:OWNER");
    const pending = [gate.begin("list"), gate.begin("resolve"), gate.begin("command")];
    gate.deactivate();
    expect(pending.every((token) => !gate.current(token))).toBe(true);
    expect(gate.active("provider-a:OWNER")).toBe(false);
    expect(() => gate.begin("list")).toThrow("inactive");
  });
});
