import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REFRESH_WINDOW_MS } from "@/lib/host/timing";
import type { AdminRefreshOutcome } from "./client-session";
import { startAdminSessionKeeper, type AdminSessionKeeperInput } from "./session-keeper";

const NOW = new Date("2026-10-23T00:00:00.000Z").getTime();

function setup(
  input: AdminSessionKeeperInput,
  refresh: () => Promise<AdminRefreshOutcome> = vi.fn(async () => ({ status: "failed" as const })),
) {
  let visibilityListener: (() => void) | undefined;
  let visible = true;
  const onSessionEnded = vi.fn();
  const stop = startAdminSessionKeeper(input, {
    now: Date.now,
    setTimer: (callback, delay) => setTimeout(callback, delay),
    clearTimer: (timer) => clearTimeout(timer),
    refresh,
    isVisible: () => visible,
    addVisibilityListener: (listener) => { visibilityListener = listener; },
    removeVisibilityListener: (listener) => {
      if (visibilityListener === listener) visibilityListener = undefined;
    },
    onSessionEnded,
  });
  return {
    refresh,
    onSessionEnded,
    stop,
    restoreVisibility() {
      visible = true;
      visibilityListener?.();
    },
  };
}

describe("AdminSessionKeeper deadline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("ends at the connection deadline when it is earlier than the ID token deadline", async () => {
    const state = setup({
      idTokenExpiresAt: NOW + 2 * 60 * 60 * 1000,
      connectionExpiresAt: NOW + 60_000,
    });

    await vi.advanceTimersByTimeAsync(59_999);
    expect(state.onSessionEnded).not.toHaveBeenCalled();
    expect(state.refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(state.onSessionEnded).toHaveBeenCalledOnce();
    expect(state.refresh).not.toHaveBeenCalled();
  });

  it("does not extend the absolute deadline after a refresh returns a later ID token deadline", async () => {
    const refresh = vi.fn(async () => ({ status: "ok" as const, idTokenExpiresAt: NOW + 2 * 60 * 60 * 1000 }));
    const state = setup({
      idTokenExpiresAt: NOW + REFRESH_WINDOW_MS,
      connectionExpiresAt: NOW + 60_000,
    }, refresh);

    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(state.onSessionEnded).toHaveBeenCalledOnce();
  });

  it("ends at the absolute deadline while refresh attempts keep failing", async () => {
    const state = setup({
      idTokenExpiresAt: NOW + REFRESH_WINDOW_MS,
      connectionExpiresAt: NOW + 65_000,
    });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(state.refresh).toHaveBeenCalledTimes(3);
    expect(state.onSessionEnded).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(state.onSessionEnded).toHaveBeenCalledOnce();
  });

  it("ends at the absolute deadline while a network request is still pending", async () => {
    const refresh = vi.fn(() => new Promise<AdminRefreshOutcome>(() => undefined));
    const state = setup({
      idTokenExpiresAt: NOW + REFRESH_WINDOW_MS,
      connectionExpiresAt: NOW + 60_000,
    }, refresh);

    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(state.onSessionEnded).toHaveBeenCalledOnce();
  });

  it("ends immediately when the page becomes visible after the connection deadline", () => {
    const state = setup({
      idTokenExpiresAt: NOW + 2 * 60 * 60 * 1000,
      connectionExpiresAt: NOW + 60_000,
    });
    vi.setSystemTime(NOW + 60_000);

    state.restoreVisibility();

    expect(state.onSessionEnded).toHaveBeenCalledOnce();
    expect(state.refresh).not.toHaveBeenCalled();
  });

  it("ends while a refresh is still pending and ignores its late success", async () => {
    let finishRefresh!: (outcome: AdminRefreshOutcome) => void;
    const refresh = vi.fn(() => new Promise<AdminRefreshOutcome>((resolve) => { finishRefresh = resolve; }));
    const state = setup({
      idTokenExpiresAt: NOW + REFRESH_WINDOW_MS,
      connectionExpiresAt: NOW + 60_000,
    }, refresh);
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(state.onSessionEnded).toHaveBeenCalledOnce();
    finishRefresh({ status: "ok", idTokenExpiresAt: NOW + 2 * 60 * 60 * 1000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(state.onSessionEnded).toHaveBeenCalledOnce();
  });
});
