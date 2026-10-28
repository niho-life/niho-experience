"use client";

import { useEffect } from "react";
import { isStandaloneDisplay } from "@/lib/host/display";
import { HOST_HOME_PATH, HOST_INTRO_PATH, HOST_LOGIN_PATH } from "@/lib/host/routes";
import { HostLoginLink, useStandaloneDisplay } from "./HostAppWindow";
import { hostButtonClass, HOST_HEADING } from "./host-ui";

/**
 * /host/launch, where the installed app opens (#177). The app signs in on its own (`?surface=app`):
 * a session it finds here came from the browser, so it is never used. In a browser, a signed-in host
 * goes on to ホーム. The server renders the browser's sign-in link; the app's is set once mounted.
 */
export function HostLaunchScreen({ hasSession }: { hasSession: boolean }) {
  const standalone = useStandaloneDisplay();

  useEffect(() => {
    // Asked directly: while hydrating, `standalone` is still the server's false.
    if (hasSession && !isStandaloneDisplay()) window.location.replace(HOST_HOME_PATH);
  }, [hasSession]);

  if (hasSession && !standalone) {
    return (
      <main id="main" className="mx-auto w-full max-w-xl px-4 py-16">
        <p role="status" className="text-ink-soft">ホームを開いています…</p>
      </main>
    );
  }

  return (
    <main id="main" className="mx-auto w-full max-w-xl px-4 py-16">
      {/* eslint-disable-next-line @next/next/no-img-element -- a fixed 192px icon from public/ */}
      <img src="/host-app/icon-192.png" alt="" width={64} height={64} className="size-16 rounded-2xl" />
      <h1 className={`${HOST_HEADING} mt-6 text-2xl`}>NIHO 体験ホスト</h1>
      <p className="mt-3 text-ink-soft">この端末で NIHO にログインすると、体験の予約やメッセージをここで確かめられます。</p>
      {/* Plain links: login is a route handler, and /host belongs to the traveler site's root. */}
      <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-4">
        <HostLoginLink href={HOST_LOGIN_PATH} className={hostButtonClass("primary")}>
          NIHO でログイン
        </HostLoginLink>
        <a href={HOST_INTRO_PATH} className="text-[0.875rem] font-bold text-ink-soft underline underline-offset-4 hover:text-ink">
          体験の提供について
        </a>
      </div>
    </main>
  );
}
