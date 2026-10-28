"use client";

import { useSyncExternalStore } from "react";
import { hostInstallGuide, type HostInstallGuide } from "@/lib/host/pwa";
import { useStandaloneDisplay } from "./HostAppWindow";
import { consoleButtonClass } from "./host-ui";
import { hostInstallState, setHostInstallState, subscribeHostInstall } from "./HostPwaRegistrar";

const noSubscription = () => () => {};

const GUIDE_TEXT: Record<Exclude<HostInstallGuide["kind"], "prompt">, string> = {
  installed: "この端末ではアプリとして使っています。",
  ios: "共有ボタンから「ホーム画面に追加」を選んでください。",
  "mac-safari": "メニューの「ファイル › Dock に追加」を選んでください。",
  other: "ブラウザのメニューから、ホーム画面やアプリとして追加できる場合があります。",
};

/**
 * 設定 › この端末 › アプリ (#177): how to add the console to this device, or that it already is.
 * The device is known only in the browser, so the server renders an empty row.
 */
export function HostAppInstall({ labelId }: { labelId: string }) {
  const standalone = useStandaloneDisplay();
  const install = useSyncExternalStore(subscribeHostInstall, hostInstallState, () => null);
  const hydrated = useSyncExternalStore(noSubscription, () => true, () => false);

  const guide = hydrated
    ? hostInstallGuide({ standalone, canPrompt: Boolean(install?.prompt), userAgent: navigator.userAgent, platform: navigator.platform, maxTouchPoints: navigator.maxTouchPoints })
    : null;

  const offer = async () => {
    const prompt = install?.prompt;
    if (!prompt) return;
    // An offer can be shown once; Chromium sends a new one if the host says no.
    setHostInstallState({ prompt: null, installed: false });
    await prompt.prompt();
    const choice = await prompt.userChoice;
    if (choice.outcome === "accepted") setHostInstallState({ prompt: null, installed: true });
  };

  return (
    <div role="group" aria-labelledby={labelId} className="flex min-h-10 flex-wrap items-center gap-2.5">
      {!guide ? null : install?.installed && guide.kind !== "installed" ? (
        <p role="status" className="text-ink-soft">この端末に追加しました。次からはアプリとして開けます。</p>
      ) : guide.kind === "prompt" ? (
        <button type="button" className={consoleButtonClass("secondary", "sm")} onClick={() => void offer()}>
          {guide.label}
        </button>
      ) : (
        <p className="text-ink-soft">{GUIDE_TEXT[guide.kind]}</p>
      )}
    </div>
  );
}
