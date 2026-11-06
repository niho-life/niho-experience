"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useSyncExternalStore } from "react";
import { HOST_EXPERIENCES_PATH, HOST_SHARED_QUERY } from "@/lib/host/routes";
import { clearSharedPhoto, holdSharedPhoto, markSharedPhotoMissed, sharedPhotoState, subscribeSharedPhoto, takeSharedPhotoFromWorker } from "@/lib/host/shared-photo";
import { consoleButtonClass } from "./host-ui";

const BOX = "mb-4 rounded-2xl border border-line bg-sand/60 p-4 text-sm leading-relaxed";

function useSharedPhoto() {
  return useSyncExternalStore(subscribeSharedPhoto, sharedPhotoState, sharedPhotoState);
}

/**
 * In the host root layout, with the app on (#177 P3). The share sheet sends the host to 体験 with `?shared=photo` (or
 * `none` when no worker took the photo): this takes the photo from the worker once, holds it in memory for the photo form and
 * removes the parameter, so a reload does not look for it again.
 */
export function HostSharedPhotoReceiver({ enabled }: { enabled: boolean }) {
  useEffect(() => {
    if (!enabled) return;
    const url = new URL(window.location.href);
    const shared = url.searchParams.get(HOST_SHARED_QUERY);
    if (shared !== "photo" && shared !== "none") return;
    url.searchParams.delete(HOST_SHARED_QUERY);
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    if (shared === "none") {
      markSharedPhotoMissed();
      return;
    }
    void takeSharedPhotoFromWorker().then((photo) => (photo ? holdSharedPhoto(photo) : markSharedPhotoMissed()));
  }, [enabled]);
  return null;
}

/** At the top of every console page while a shared photo waits or did not arrive: where to use it, or to share it again. */
export function HostSharedPhotoNotice() {
  const { photo, missed } = useSharedPhoto();
  const pathname = usePathname();
  if (!photo && !missed) return null;
  const onExperiences = pathname === HOST_EXPERIENCES_PATH || pathname.startsWith(`${HOST_EXPERIENCES_PATH}/`);
  return (
    <div role="status" className={BOX}>
      {photo ? (
        <p>共有された写真「<span className="[overflow-wrap:anywhere]">{photo.name}</span>」を受け取りました。写真を追加する体験の編集画面で「この写真を使う」を押してください。</p>
      ) : (
        <p>共有された写真を受け取れませんでした。もう一度、写真アプリの共有から「体験ホスト」を選んでください。</p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {photo && !onExperiences ? <Link href={HOST_EXPERIENCES_PATH} className={consoleButtonClass("secondary", "sm")}>体験を開く</Link> : null}
        <button type="button" className={consoleButtonClass("secondary", "sm")} onClick={clearSharedPhoto}>{photo ? "この写真を使わない" : "閉じる"}</button>
      </div>
    </div>
  );
}

/**
 * In 体験's photo form, above the file input. Using the photo only selects it: the rights confirmation, the
 * descriptions and the upload are the form's own, as for a photo picked from the device.
 */
export function HostSharedPhotoOffer({ disabled, onUse }: { disabled: boolean; onUse: (photo: File) => void }) {
  const { photo } = useSharedPhoto();
  if (!photo) return null;
  return (
    <div className="rounded-xl border border-line bg-sand/60 p-3 text-sm">
      <p>共有された写真「<span className="[overflow-wrap:anywhere]">{photo.name}</span>」があります。</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" disabled={disabled} className={consoleButtonClass("secondary", "sm")} onClick={() => { onUse(photo); clearSharedPhoto(); }}>この写真を使う</button>
        <button type="button" disabled={disabled} className={consoleButtonClass("secondary", "sm")} onClick={clearSharedPhoto}>使わない</button>
      </div>
    </div>
  );
}
