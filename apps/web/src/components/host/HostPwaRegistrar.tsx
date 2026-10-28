"use client";

import { useEffect } from "react";
import { HOST_APP_SCOPE, HOST_SW_PATH } from "@/lib/host/routes";

/** Chromium's install offer; not in the DOM typings. */
export interface HostInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

/** Kept on window so 設定 › この端末 can offer it after moving between pages (#177). */
export interface HostInstallState {
  prompt: HostInstallPromptEvent | null;
  installed: boolean;
}

declare global {
  interface Window {
    __nihoHostInstall?: HostInstallState;
  }
}

const INSTALL_CHANGE = "niho-host-install-change";

/** For useSyncExternalStore. Each change replaces the object, so it is its own snapshot. */
export function subscribeHostInstall(onChange: () => void): () => void {
  window.addEventListener(INSTALL_CHANGE, onChange);
  return () => window.removeEventListener(INSTALL_CHANGE, onChange);
}

export function hostInstallState(): HostInstallState | null {
  return window.__nihoHostInstall ?? null;
}

export function setHostInstallState(next: HostInstallState) {
  window.__nihoHostInstall = next;
  window.dispatchEvent(new Event(INSTALL_CHANGE));
}

/**
 * In the host root layout only, so traveler pages never register a worker (#177). Enabled: registers
 * /host/sw.js for /host/ and keeps Chromium's install offer for 設定. Disabled (HOST_PWA_ENABLED=false):
 * removes a worker an earlier visit registered; the server's sw.js removes itself as well.
 */
export function HostPwaRegistrar({ enabled }: { enabled: boolean }) {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    if (enabled) {
      // Without a worker the console still works; only the offline page is missing.
      navigator.serviceWorker.register(HOST_SW_PATH, { scope: HOST_APP_SCOPE, updateViaCache: "none" }).catch(() => undefined);
      return;
    }
    navigator.serviceWorker
      .getRegistrations()
      .then((registrations) => Promise.all(registrations.filter((registration) => registration.scope.endsWith(HOST_APP_SCOPE)).map((registration) => registration.unregister())))
      .catch(() => undefined);
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    const onPrompt = (event: Event) => {
      // Offered from 設定 › この端末 instead of the browser's own banner.
      event.preventDefault();
      setHostInstallState({ prompt: event as HostInstallPromptEvent, installed: false });
    };
    const onInstalled = () => setHostInstallState({ prompt: null, installed: true });
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, [enabled]);

  return null;
}
