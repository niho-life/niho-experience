"use client";

import { useEffect, useRef, useState } from "react";
import { confirmNotificationAddress } from "@/host/actions";
import { HOST_SETTINGS_PATH } from "@/lib/host/routes";
import { hostButtonClass, HOST_SURFACE } from "./host-ui";

type View =
  | { kind: "reading" }
  | { kind: "ready" }
  | { kind: "confirming" }
  | { kind: "done"; email: string }
  /** Unknown, used, cancelled or an hour old: the page does not say which. */
  | { kind: "closed" }
  | { kind: "failed" };

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** `#t=<token>` from the address bar, or null. */
export function notificationEmailToken(hash: string): string | null {
  const value = new URLSearchParams(hash.replace(/^#/, "")).get("t");
  return value && TOKEN.test(value) ? value : null;
}

/**
 * 通知の宛先の確認 (#194): the token is taken out of the address bar at once and kept in memory only. 「このアドレスに切り替える」
 * posts it (a server action); the experience DB makes the address the one in use if the link is still good (an hour, once).
 */
export function HostNotificationEmailConfirm() {
  const token = useRef<string | null>(null);
  const [view, setView] = useState<View>({ kind: "reading" });

  useEffect(() => {
    token.current = notificationEmailToken(window.location.hash) ?? token.current;
    if (window.location.hash) window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`);
    // After the first paint: the server render and the first client render agree.
    queueMicrotask(() => setView({ kind: token.current ? "ready" : "closed" }));
  }, []);

  const confirm = async () => {
    if (!token.current || view.kind === "confirming") return;
    setView({ kind: "confirming" });
    try {
      const result = await confirmNotificationAddress({ token: token.current });
      if (result.ok) {
        token.current = null;
        setView({ kind: "done", email: result.email });
      } else {
        if (result.closed) token.current = null;
        setView({ kind: result.closed ? "closed" : "failed" });
      }
    } catch {
      setView({ kind: "failed" });
    }
  };

  return (
    <main id="main" className="mx-auto grid min-h-dvh w-full max-w-xl place-items-center px-4 py-10">
      <section className={`${HOST_SURFACE} w-full p-5 sm:p-7`} aria-labelledby="notification-email-title" aria-busy={view.kind === "reading" || view.kind === "confirming"}>
        <p className="text-xs font-extrabold tracking-[0.08em] text-muted">NIHO EXPERIENCE</p>
        <h1 id="notification-email-title" className="mt-2 font-display text-2xl font-medium">通知の宛先の確認</h1>
        {view.kind === "reading" ? <p role="status" className="mt-4 text-ink-soft">確認しています…</p> : null}
        {view.kind === "ready" || view.kind === "confirming" ? (
          <>
            <p className="mt-4 text-ink-soft">このメールを受け取ったアドレスに、予約などの通知が届くようにします。</p>
            <button type="button" disabled={view.kind === "confirming"} onClick={() => void confirm()} className={`${hostButtonClass("primary")} mt-6 w-full justify-center disabled:opacity-50`}>
              {view.kind === "confirming" ? "切り替えています…" : "このアドレスに切り替える"}
            </button>
          </>
        ) : null}
        {view.kind === "done" ? (
          <>
            <p role="status" className="mt-4 [overflow-wrap:anywhere]">
              通知の宛先を <strong>{view.email}</strong> に切り替えました。
            </p>
            <a href={`${HOST_SETTINGS_PATH}#settings-notification`} className={`${hostButtonClass("secondary")} mt-6 w-full justify-center`}>
              設定を開く
            </a>
          </>
        ) : null}
        {view.kind === "closed" ? (
          <p role="alert" className="mt-4 rounded-xl bg-warn-pale p-3 text-warn">
            このリンクはもう使えません。リンクは確認のメールを送ってから 1 時間、1 回だけ使えます。設定 › 通知 から、もう一度確認のメールを送ってください。
          </p>
        ) : null}
        {view.kind === "failed" ? (
          <p role="alert" className="mt-4 rounded-xl bg-warn-pale p-3 text-warn">
            切り替えられませんでした。時間をおいて、もう一度お試しください。リンクはまだ使えます。
          </p>
        ) : null}
        {view.kind === "failed" ? (
          <button type="button" onClick={() => void confirm()} className={`${hostButtonClass("primary")} mt-4 w-full justify-center`}>
            もう一度試す
          </button>
        ) : null}
      </section>
    </main>
  );
}
