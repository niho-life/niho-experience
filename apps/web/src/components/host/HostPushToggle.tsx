"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { hostFetch } from "@/lib/host/client-session";
import { hostPushAvailability, type HostPushAvailability } from "@/lib/host/pwa";
import { HOST_APP_SCOPE } from "@/lib/host/routes";
import { useStandaloneDisplay } from "./HostAppWindow";
import { consoleButtonClass } from "./host-ui";

const noSubscription = () => () => {};
const READY_TIMEOUT_MS = 10_000;

const UNAVAILABLE_TEXT: Record<Exclude<HostPushAvailability, "available">, string> = {
  unsupported: "このブラウザでは通知を受け取れません。",
  "ios-install": "ホーム画面に追加したアプリから通知を受け取れます。",
  denied: "通知が許可されていません。端末の設定から許可してください。",
};

function hasPush(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

/** The browser's applicationServerKey from the server's base64url public key. */
function serverKey(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

function sameKey(current: ArrayBuffer | null | undefined, wanted: Uint8Array): boolean {
  if (!current || current.byteLength !== wanted.length) return false;
  const bytes = new Uint8Array(current);
  return bytes.every((byte, index) => byte === wanted[index]);
}

/** This device's subscription, if the console's worker is registered. */
async function currentSubscription(): Promise<PushSubscription | null> {
  const registration = await navigator.serviceWorker.getRegistration(HOST_APP_SCOPE);
  return registration ? registration.pushManager.getSubscription() : null;
}

function readyWorker(): Promise<ServiceWorkerRegistration> {
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("service worker not ready")), READY_TIMEOUT_MS)),
  ]);
}

const json = (method: "POST" | "DELETE", body: unknown): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/**
 * 設定 › この端末 › 通知 (#177 P2): push on this device, next to the email NIHO already sends.
 * Permission is asked only from the button (iOS: only inside the app). On load the server is asked
 * whether this device is still the host's, so a logout or a revoked connection elsewhere shows as off.
 */
export function HostPushToggle({ labelId, vapidPublicKey }: { labelId: string; vapidPublicKey: string }) {
  const standalone = useStandaloneDisplay();
  const hydrated = useSyncExternalStore(noSubscription, () => true, () => false);
  const [state, setState] = useState<"checking" | "off" | "on" | "unknown">("checking");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  const availability = hydrated
    ? hostPushAvailability({
        standalone,
        hasPush: hasPush(),
        permission: "Notification" in window ? Notification.permission : null,
        userAgent: navigator.userAgent,
        platform: navigator.platform,
        maxTouchPoints: navigator.maxTouchPoints,
      })
    : null;

  useEffect(() => {
    if (availability !== "available") return;
    let stopped = false;
    const check = async (): Promise<{ on: boolean; keyChanged: boolean }> => {
      const subscription = await currentSubscription();
      if (!subscription) return { on: false, keyChanged: false };
      if (!sameKey(subscription.options.applicationServerKey, serverKey(vapidPublicKey))) {
        return { on: false, keyChanged: true };
      }
      const response = await hostFetch("push-subscriptions/status", json("POST", { endpoint: subscription.endpoint }));
      if (!response.ok) throw new Error("status unavailable");
      const body = (await response.json()) as { subscribed?: unknown };
      if (typeof body.subscribed !== "boolean") throw new Error("invalid status");
      return { on: body.subscribed, keyChanged: false };
    };
    check()
      .then(({ on, keyChanged }) => {
        if (stopped) return;
        setState(on ? "on" : "off");
        if (keyChanged) setNotice("通知の鍵が更新されました。もう一度オンにしてください。");
      })
      .catch(() => {
        if (stopped) return;
        setState("unknown");
        setNotice("通知の状態を確認できません。通信を確認してページを再読み込みしてください。");
      });
    return () => {
      stopped = true;
    };
  }, [availability, vapidPublicKey]);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setNotice("");
    try {
      await work();
    } finally {
      setBusy(false);
    }
  };

  const turnOn = () =>
    run(async () => {
      try {
        // First, inside the tap: iOS asks only from a user gesture.
        const permission = await Notification.requestPermission();
        if (permission !== "granted") {
          if (permission === "default") setNotice("通知を許可すると、この端末に届きます。");
          return;
        }
        const registration = await readyWorker();
        const key = serverKey(vapidPublicKey);
        let subscription = await registration.pushManager.getSubscription();
        if (subscription && !sameKey(subscription.options.applicationServerKey, key)) {
          if (!(await subscription.unsubscribe())) throw new Error("old subscription not removed");
          subscription = null;
        }
        subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
        const response = await hostFetch("push-subscriptions", json("POST", subscription.toJSON()));
        if (!response.ok) {
          await subscription.unsubscribe().catch(() => false);
          throw new Error("not saved");
        }
        setState("on");
      } catch {
        setNotice("通知をオンにできませんでした。時間をおいてもう一度お試しください。");
      }
    });

  const turnOff = () =>
    run(async () => {
      try {
        const subscription = await currentSubscription();
        if (subscription) {
          const { endpoint } = subscription;
          const unsubscribed = await subscription.unsubscribe().catch(() => false);
          // The server row would also go when the push service answers 410; this is sooner.
          const response = await hostFetch("push-subscriptions", json("DELETE", { endpoint })).catch(() => null);
          if (!unsubscribed && !response?.ok) throw new Error("subscription still active");
        }
        setState("off");
      } catch {
        setNotice("通知を止められませんでした。もう一度お試しください。");
      }
    });

  const sendTest = () =>
    run(async () => {
      try {
        const subscription = await currentSubscription();
        if (!subscription) {
          setState("off");
          return;
        }
        const response = await hostFetch("push-subscriptions/test", json("POST", { endpoint: subscription.endpoint }));
        if (response.ok) {
          const body = (await response.json()) as { preview?: unknown };
          setNotice(body.preview === true ? "プレビューでは通知を送りません。" : "テスト通知を送りました。");
        } else if (response.status === 429) {
          setNotice("少し待ってから、もう一度お試しください。");
        } else if (response.status === 404 || response.status === 410) {
          setState("off");
          setNotice("この端末の通知は止まっています。もう一度オンにしてください。");
        } else {
          setNotice("テスト通知を送れませんでした。時間をおいてもう一度お試しください。");
        }
      } catch {
        setNotice("テスト通知を送れませんでした。時間をおいてもう一度お試しください。");
      }
    });

  let content = null;
  if (availability && availability !== "available") content = <p className="text-ink-soft">{UNAVAILABLE_TEXT[availability]}</p>;
  else if (availability === "available" && state === "unknown") content = <span>通知の状態を確認できません。</span>;
  else if (availability === "available" && state === "off") {
    content = (
      <button type="button" className={consoleButtonClass("secondary", "sm")} disabled={busy} onClick={() => void turnOn()}>
        この端末で通知を受け取る
      </button>
    );
  } else if (availability === "available" && state === "on") {
    content = (
      <>
        <span>この端末に通知が届きます</span>
        <button type="button" className={consoleButtonClass("secondary", "sm")} disabled={busy} onClick={() => void sendTest()}>
          テスト通知を送る
        </button>
        <button type="button" className={consoleButtonClass("ghost", "sm")} disabled={busy} onClick={() => void turnOff()}>
          この端末の通知を止める
        </button>
      </>
    );
  }

  return (
    <div className="space-y-1.5">
      <div role="group" aria-labelledby={labelId} aria-busy={busy || (availability === "available" && state === "checking")} className="flex min-h-10 flex-wrap items-center gap-2.5">
        {content}
      </div>
      <p role="status" className="text-[0.8125rem] text-ink-soft empty:hidden">
        {notice}
      </p>
      <p className="text-xs leading-normal text-muted">届く通知の種類は「通知」の設定に従います。ロック画面には体験名・日時・人数だけを表示します。</p>
    </div>
  );
}
