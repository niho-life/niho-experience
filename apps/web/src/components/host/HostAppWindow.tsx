"use client";

import { useRouter } from "next/navigation";
import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import { HOST_PUSH_MESSAGE, isStandaloneDisplay, subscribeDisplayMode } from "@/lib/host/display";
import { HOST_LAUNCH_PATH, withQuery } from "@/lib/host/routes";

/** True inside the installed app (#177). False on the server and while hydrating, so the first render matches. */
export function useStandaloneDisplay(): boolean {
  return useSyncExternalStore(subscribeDisplayMode, isStandaloneDisplay, () => false);
}

/**
 * 「NIHO でログイン」links: inside the installed app the sign-in is marked as the app's own (#177), so
 * the console does not send the host to sign in a second time. The server renders the browser's link.
 */
export function HostLoginLink({ href, className, children }: { href: string; className?: string; children: ReactNode }) {
  const standalone = useStandaloneDisplay();
  return (
    <a href={standalone ? withQuery(href, { surface: "app" }) : href} className={className}>
      {children}
    </a>
  );
}

/**
 * Inside the installed app, a session signed in elsewhere is the browser's, copied in by iOS or
 * macOS Safari (#177). The console sends it to the app's start page, which signs in inside the app.
 * The refresh call refuses such a session anyway; this spares the host a page that soon stops working.
 */
export function HostAppSurfaceGuard({ enabled, appSurface }: { enabled: boolean; appSurface: boolean }) {
  const standalone = useStandaloneDisplay();
  useEffect(() => {
    if (enabled && standalone && !appSurface) window.location.replace(HOST_LAUNCH_PATH);
  }, [enabled, standalone, appSurface]);
  return null;
}

const RESUME_AFTER_MS = 60_000;

/**
 * The app has no reload button: back from a minute or more in the background, or after a push
 * arrived while it was away (#177 P2, the service worker's message), the page loads again, unless
 * something on it is not saved yet (the leave guard's state). A full load rather than router.refresh():
 * 予約 and メッセージ keep their lists in client state, which a refresh leaves as is. A push while the
 * app is in front only refreshes the server's parts (ホーム's todos and the icon's count), without
 * pulling the page from under the host.
 */
export function HostResumeRefresh({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const standalone = useStandaloneDisplay();
  useEffect(() => {
    if (!enabled || !standalone) return;
    const unsaved = () => window.__nihoHostHistoryGuard?.dirty === true;
    let hiddenAt = document.visibilityState === "hidden" ? Date.now() : null;
    let pushedWhileAway = false;
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        hiddenAt = Date.now();
        return;
      }
      const away = hiddenAt === null ? 0 : Date.now() - hiddenAt;
      hiddenAt = null;
      const stale = pushedWhileAway || away >= RESUME_AFTER_MS;
      pushedWhileAway = false;
      if (stale && !unsaved()) window.location.reload();
    };
    const onMessage = (event: MessageEvent) => {
      if ((event.data as { type?: unknown } | null)?.type !== HOST_PUSH_MESSAGE) return;
      if (document.visibilityState === "hidden") pushedWhileAway = true;
      else if (!unsaved()) router.refresh();
    };
    const worker = "serviceWorker" in navigator ? navigator.serviceWorker : null;
    document.addEventListener("visibilitychange", onVisibility);
    worker?.addEventListener("message", onMessage);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      worker?.removeEventListener("message", onMessage);
    };
  }, [enabled, standalone, router]);
  return null;
}

/**
 * The app icon's count on ホーム (#177 P2): the requests waiting for approval and the threads waiting
 * for an answer, for the provider shown. Only inside the app, where the Badging API exists.
 */
export function HostAppBadge({ enabled, count }: { enabled: boolean; count: number }) {
  const standalone = useStandaloneDisplay();
  useEffect(() => {
    if (!enabled || !standalone || !("setAppBadge" in navigator)) return;
    void (count > 0 ? navigator.setAppBadge(count) : navigator.clearAppBadge()).catch(() => undefined);
  }, [enabled, standalone, count]);
  return null;
}
