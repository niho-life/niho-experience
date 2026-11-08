import { afterEach, describe, expect, it, vi } from "vitest";
import { createHostMembershipMonitor, HOST_MEMBERSHIP_TIMEOUT_MS } from "./HostMembershipGuard";

const BASELINE = "a".repeat(64);
const json = (fingerprint: string, status = 200) => new Response(JSON.stringify({ contractVersion: 1, fingerprint }), {
  status, headers: { "content-type": "application/json" },
});

afterEach(() => vi.useRealTimers());

describe("HostMembershipGuard access monitor", () => {
  it("keeps one request in flight and accepts only the exact baseline", async () => {
    let release!: (response: Response) => void;
    const fetchAccess = vi.fn(() => new Promise<Response>((resolve) => { release = resolve; })) as unknown as typeof fetch;
    const fail = vi.fn();
    const monitor = createHostMembershipMonitor(BASELINE, fail, fetchAccess);
    const first = monitor.verify(); const duplicate = monitor.verify();
    expect(fetchAccess).toHaveBeenCalledTimes(1);
    release(json(BASELINE));
    await Promise.all([first, duplicate]);
    expect(fail).not.toHaveBeenCalled();
    const second = monitor.verify();
    expect(fetchAccess).toHaveBeenCalledTimes(2);
    release(json(BASELINE));
    await second;
    monitor.stop();
  });

  it("fails closed for a changed, invalid or failed response", async () => {
    for (const [response, reason] of [
      [json("b".repeat(64)), "changed"],
      [new Response(JSON.stringify({ fingerprint: BASELINE }), { status: 200 }), "unavailable"],
      [new Response(null, { status: 503 }), "unavailable"],
    ] as const) {
      const fail = vi.fn();
      const monitor = createHostMembershipMonitor(BASELINE, fail, vi.fn(async () => response) as unknown as typeof fetch);
      await monitor.verify();
      expect(fail).toHaveBeenCalledOnce(); expect(fail).toHaveBeenCalledWith(reason);
      monitor.stop();
    }
  });

  it("times out and ignores a response that arrives after private content was closed", async () => {
    vi.useFakeTimers();
    let release!: (response: Response) => void;
    const fetchAccess = vi.fn(() => new Promise<Response>((resolve) => { release = resolve; })) as unknown as typeof fetch;
    const fail = vi.fn();
    const monitor = createHostMembershipMonitor(BASELINE, fail, fetchAccess);
    const checking = monitor.verify();
    await vi.advanceTimersByTimeAsync(HOST_MEMBERSHIP_TIMEOUT_MS);
    expect(fail).toHaveBeenCalledWith("unavailable");
    release(json(BASELINE));
    await checking;
    expect(fail).toHaveBeenCalledTimes(1);
    expect(fetchAccess).toHaveBeenCalledTimes(1);
  });

  it("aborts cleanup and never applies an old delayed response to a replacement monitor", async () => {
    let release!: (response: Response) => void;
    const oldFail = vi.fn();
    const old = createHostMembershipMonitor(BASELINE, oldFail, vi.fn((_url, init) => new Promise<Response>((resolve) => {
      expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal); release = resolve;
    })) as unknown as typeof fetch);
    const pending = old.verify(); old.stop();
    const newFail = vi.fn();
    const replacement = createHostMembershipMonitor("b".repeat(64), newFail, vi.fn(async () => json("b".repeat(64))) as unknown as typeof fetch);
    await replacement.verify();
    release(json("c".repeat(64))); await pending;
    expect(oldFail).not.toHaveBeenCalled(); expect(newFail).not.toHaveBeenCalled();
    replacement.stop();
  });
});
