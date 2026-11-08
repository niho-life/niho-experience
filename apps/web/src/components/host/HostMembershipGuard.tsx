"use client";

import { useCallback, useEffect, useState } from "react";

export const HOST_MEMBERSHIP_POLL_MS = 20_000;
export const HOST_MEMBERSHIP_TIMEOUT_MS = 7_000;
const SHA256 = /^[0-9a-f]{64}$/;

type Failure = "changed" | "unavailable";
type Monitor = { readonly verify: () => Promise<void>; readonly stop: () => void };

function responseFingerprint(value: unknown): string | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === 2
    && (value as Record<string, unknown>).contractVersion === 1
    && typeof (value as Record<string, unknown>).fingerprint === "string"
    && SHA256.test((value as Record<string, unknown>).fingerprint as string)
    ? (value as { fingerprint: string }).fingerprint : null;
}

/** One in-flight check at a time. Timeout fails closed even when fetch ignores AbortSignal. */
export function createHostMembershipMonitor(
  baseline: string,
  fail: (reason: Failure) => void,
  fetchAccess: typeof fetch = fetch,
): Monitor {
  let active = true;
  let failed = false;
  let sequence = 0;
  let inFlight: Promise<void> | null = null;
  let controller: AbortController | null = null;
  let timeout: ReturnType<typeof setTimeout> | undefined;

  const deny = (reason: Failure) => {
    if (!active || failed) return;
    failed = true;
    sequence += 1;
    controller?.abort();
    fail(reason);
  };

  return {
    verify() {
      if (!active || failed) return Promise.resolve();
      if (inFlight) return inFlight;
      const current = ++sequence;
      controller = new AbortController();
      timeout = globalThis.setTimeout(() => deny("unavailable"), HOST_MEMBERSHIP_TIMEOUT_MS);
      inFlight = (async () => {
        try {
          const response = await fetchAccess("/host/api/team/access", { cache: "no-store", signal: controller!.signal });
          const value: unknown = response.ok ? await response.json() : null;
          if (!active || failed || current !== sequence) return;
          const fingerprint = responseFingerprint(value);
          if (!response.ok || fingerprint === null) deny("unavailable");
          else if (fingerprint !== baseline) deny("changed");
        } catch {
          if (active && !failed && current === sequence) deny("unavailable");
        } finally {
          globalThis.clearTimeout(timeout);
          if (current === sequence && !failed) {
            inFlight = null;
            controller = null;
          }
        }
      })();
      return inFlight;
    },
    stop() {
      active = false;
      sequence += 1;
      controller?.abort();
      globalThis.clearTimeout(timeout);
      controller = null;
      inFlight = null;
    },
  };
}

/**
 * Native sessions are revalidated immediately, every 20 seconds, and on focus/visibility/pageshow. API authorization
 * remains immediate. Unknown or changed access unmounts private children and stays closed until an explicit reload.
 */
export function HostMembershipGuard({ initialFingerprint, children }: { readonly initialFingerprint: string; readonly children: React.ReactNode }) {
  const [failure, setFailure] = useState<Failure | null>(null);
  const reload = useCallback(() => window.location.reload(), []);

  useEffect(() => {
    const monitor = createHostMembershipMonitor(initialFingerprint, setFailure);
    const verify = () => { if (document.visibilityState === "visible") void monitor.verify(); };
    void monitor.verify();
    const timer = window.setInterval(() => void monitor.verify(), HOST_MEMBERSHIP_POLL_MS);
    window.addEventListener("focus", verify);
    window.addEventListener("pageshow", verify);
    document.addEventListener("visibilitychange", verify);
    return () => {
      monitor.stop();
      window.clearInterval(timer);
      window.removeEventListener("focus", verify);
      window.removeEventListener("pageshow", verify);
      document.removeEventListener("visibilitychange", verify);
    };
  }, [initialFingerprint]);

  if (!failure) return children;
  return (
    <main className="min-h-screen bg-canvas p-6">
      <div role="alert" className="mx-auto max-w-xl rounded-xl bg-danger-pale p-4 text-danger">
        <p>{failure === "changed" ? "アクセス権が変更されたため、安全のため画面を閉じました。" : "アクセス権を確認できないため、安全のため画面を閉じました。"}</p>
        <button type="button" onClick={reload} className="mt-3 rounded-lg border border-current px-3 py-2 font-bold">再読込して確認</button>
      </div>
    </main>
  );
}
