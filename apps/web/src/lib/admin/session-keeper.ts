import type { AdminRefreshOutcome } from "./client-session";
import { REFRESH_WINDOW_MS } from "@/lib/host/timing";

const RETRY_MS = 30_000;

export interface AdminSessionKeeperInput {
  idTokenExpiresAt: number;
  connectionExpiresAt: number;
}

export interface AdminSessionKeeperDeps {
  now: () => number;
  setTimer: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
  refresh: () => Promise<AdminRefreshOutcome>;
  isVisible: () => boolean;
  addVisibilityListener: (listener: () => void) => void;
  removeVisibilityListener: (listener: () => void) => void;
  onSessionEnded: () => void;
}

/** Keep the short ID token fresh without ever extending the NIHO connection deadline. */
export function startAdminSessionKeeper(input: AdminSessionKeeperInput, deps: AdminSessionKeeperDeps): () => void {
  let idTokenExpiresAt = input.idTokenExpiresAt;
  const connectionExpiresAt = input.connectionExpiresAt;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let refreshing = false;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (refreshTimer !== undefined) deps.clearTimer(refreshTimer);
    if (deadlineTimer !== undefined) deps.clearTimer(deadlineTimer);
    refreshTimer = undefined;
    deadlineTimer = undefined;
    deps.removeVisibilityListener(onVisible);
  };

  const endIfConnectionExpired = () => {
    if (deps.now() < connectionExpiresAt) return false;
    stop();
    deps.onSessionEnded();
    return true;
  };

  const schedule = (preferredDelay: number) => {
    if (stopped || endIfConnectionExpired()) return;
    if (refreshTimer !== undefined) deps.clearTimer(refreshTimer);
    const untilConnectionExpires = connectionExpiresAt - deps.now();
    refreshTimer = deps.setTimer(() => void run(), Math.max(0, Math.min(preferredDelay, untilConnectionExpires)));
  };

  const scheduleRefresh = (minimumDelay = 0) => {
    const untilRefresh = idTokenExpiresAt - REFRESH_WINDOW_MS - deps.now();
    schedule(Math.max(untilRefresh, minimumDelay));
  };

  const run = async () => {
    refreshTimer = undefined;
    if (stopped || endIfConnectionExpired() || refreshing) return;
    refreshing = true;
    const outcome = await deps.refresh();
    refreshing = false;
    if (stopped || endIfConnectionExpired()) return;
    if (outcome.status === "signed-out") {
      stop();
      deps.onSessionEnded();
      return;
    }
    if (outcome.status === "ok") {
      idTokenExpiresAt = outcome.idTokenExpiresAt;
      scheduleRefresh(RETRY_MS);
      return;
    }
    schedule(RETRY_MS);
  };

  function onVisible() {
    if (!deps.isVisible() || stopped || endIfConnectionExpired()) return;
    if (deps.now() >= idTokenExpiresAt - REFRESH_WINDOW_MS) void run();
  }

  deps.addVisibilityListener(onVisible);
  deadlineTimer = deps.setTimer(() => {
    deadlineTimer = undefined;
    endIfConnectionExpired();
  }, Math.max(0, connectionExpiresAt - deps.now()));
  scheduleRefresh();
  return stop;
}
