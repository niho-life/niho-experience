"use client";

import { useEffect, useState } from "react";
import { refreshAdminSession, type AdminRefreshOutcome } from "@/lib/admin/client-session";
import { ADMIN_ENTRY_PATH, ADMIN_LOGOUT_PATH } from "@/lib/admin/routes";
import { startAdminSessionKeeper } from "@/lib/admin/session-keeper";

function signedOut() {
  window.location.assign(ADMIN_ENTRY_PATH);
}

export function AdminSessionKeeper({
  idTokenExpiresAt,
  connectionExpiresAt,
}: {
  idTokenExpiresAt: number;
  connectionExpiresAt: number;
}) {
  useEffect(() => {
    return startAdminSessionKeeper({ idTokenExpiresAt, connectionExpiresAt }, {
      now: Date.now,
      setTimer: (callback, delay) => setTimeout(callback, delay),
      clearTimer: (timer) => clearTimeout(timer),
      refresh: refreshAdminSession,
      isVisible: () => document.visibilityState === "visible",
      addVisibilityListener: (listener) => document.addEventListener("visibilitychange", listener),
      removeVisibilityListener: (listener) => document.removeEventListener("visibilitychange", listener),
      onSessionEnded: signedOut,
    });
  }, [connectionExpiresAt, idTokenExpiresAt]);
  return null;
}

export function AdminRefreshGate() {
  const [outcome, setOutcome] = useState<AdminRefreshOutcome["status"] | "pending">("pending");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let stopped = false;
    void refreshAdminSession().then((result) => {
      if (stopped) return;
      if (result.status === "signed-out") return signedOut();
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
        <button type="button" className="min-h-11 rounded-full border border-line-strong px-5 font-extrabold hover:bg-sand" onClick={() => { setOutcome("pending"); setAttempt((value) => value + 1); }}>
          もう一度試す
        </button>
      </div>
    );
  }
  return <p role="status" className="text-ink-soft">管理者ログインの状態を更新しています…</p>;
}

/** A role or dedicated-client rejection removes the sealed local PII before returning to the entrance. */
export function AdminSessionEndGate() {
  useEffect(() => {
    let stopped = false;
    void fetch(ADMIN_LOGOUT_PATH, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { accept: "text/html" },
    }).then((response) => {
      if (stopped) return;
      const destination = response.redirected ? new URL(response.url).pathname : ADMIN_ENTRY_PATH;
      window.location.assign(destination.startsWith("/admin/") ? destination : ADMIN_ENTRY_PATH);
    }).catch(() => {
      if (!stopped) signedOut();
    });
    return () => {
      stopped = true;
    };
  }, []);
  return <p role="status" className="text-ink-soft">接続が終了しました。管理画面の入口へ戻ります…</p>;
}
