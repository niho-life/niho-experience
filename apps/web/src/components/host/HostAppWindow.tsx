"use client";

import { useRouter } from "next/navigation";
import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import { isStandaloneDisplay, subscribeDisplayMode } from "@/lib/host/display";
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
 * The app has no reload button: back from a minute or more in the background, the page is read
 * from the server again, unless something on it is not saved yet (the leave guard's state).
 */
export function HostResumeRefresh({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const standalone = useStandaloneDisplay();
  useEffect(() => {
    if (!enabled || !standalone) return;
    let hiddenAt = document.visibilityState === "hidden" ? Date.now() : null;
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        hiddenAt = Date.now();
        return;
      }
      const away = hiddenAt === null ? 0 : Date.now() - hiddenAt;
      hiddenAt = null;
      if (away >= RESUME_AFTER_MS && !window.__nihoHostHistoryGuard?.dirty) router.refresh();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [enabled, standalone, router]);
  return null;
}
