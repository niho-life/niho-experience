"use client";

import { useEffect, useState } from "react";
import { hostSignedOutPath, refreshHostSession, type RefreshOutcome } from "@/lib/host/client-session";
import { HOST_LAUNCH_PATH } from "@/lib/host/routes";
import { REFRESH_WINDOW_MS } from "@/lib/host/timing";
import { hostButtonClass } from "./host-ui";

const RETRY_MS = 30_000;

/** The installed app goes back to its start page, a browser to the introduction (#177). */
function signOut() {
  window.location.assign(hostSignedOutPath());
}

/** The app holds a session signed in elsewhere (#177): its start page signs in again inside the app. */
function signInInApp() {
  window.location.assign(HOST_LAUNCH_PATH);
}

/**
 * One per host page (in the console layout). Refreshes the session five minutes
 * before the ID token expires, through the cross-tab lock. Pages and the proxy
 * never refresh on their own, so a rotated refresh token is never spent twice.
 */
export function HostSessionKeeper({ idTokenExpiresAt }: { idTokenExpiresAt: number }) {
  useEffect(() => {
    let expiresAt = idTokenExpiresAt;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    const schedule = (delay: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => void run(), Math.max(delay, 0));
    };
    const run = async () => {
      const outcome = await refreshHostSession();
      if (stopped) return;
      if (outcome.status === "signed-out") return signOut();
      if (outcome.status === "app-sign-in") return signInInApp();
      if (outcome.status === "ok") {
        expiresAt = outcome.idTokenExpiresAt;
        // Never loop faster than the retry interval, even if NIHO hands out short-lived tokens.
        schedule(Math.max(expiresAt - REFRESH_WINDOW_MS - Date.now(), RETRY_MS));
      } else {
        schedule(RETRY_MS);
      }
    };
    // Timers sleep with the laptop; check again when the tab comes back.
    const onVisible = () => {
      if (document.visibilityState === "visible" && Date.now() >= expiresAt - REFRESH_WINDOW_MS) void run();
    };

    schedule(expiresAt - REFRESH_WINDOW_MS - Date.now());
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [idTokenExpiresAt]);

  return null;
}

/**
 * Shown instead of the page when the server found an expired ID token: refresh
 * through the same lock, then reload so the page renders with the new token.
 */
export function HostRefreshGate() {
  const [outcome, setOutcome] = useState<RefreshOutcome["status"] | "pending">("pending");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let stopped = false;
    void refreshHostSession().then((result) => {
      if (stopped) return;
      if (result.status === "signed-out") return signOut();
      if (result.status === "app-sign-in") return signInInApp();
      if (result.status === "ok") return window.location.reload();
      setOutcome(result.status);
    });
    return () => {
      stopped = true;
    };
  }, [attempt]);

  if (outcome === "failed") {
    return (
      <div role="alert" className="space-y-4">
        <p className="font-bold">NIHO に接続できませんでした。</p>
        <p className="text-ink-soft">通信の状態を確かめて、もう一度お試しください。</p>
        <button type="button" className={hostButtonClass("secondary")} onClick={() => { setOutcome("pending"); setAttempt((n) => n + 1); }}>
          もう一度試す
        </button>
      </div>
    );
  }
  return <p role="status" className="text-ink-soft">ログインの状態を更新しています…</p>;
}
