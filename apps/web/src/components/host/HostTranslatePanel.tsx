"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  NOT_JOINED,
  participantStatus,
  timeInJapan,
  TRANSLATE_ROOM_STATUS,
  type HostTranslateRoomEndResponse,
  type HostTranslateRoomResponse,
  type HostTranslateRoomStatusResponse,
} from "@/host/translate";
import { hostFetch } from "@/lib/host/client-session";
import { DANGER_BUTTON } from "./HostBookingDialogs";
import { HostConfirmDialog } from "./HostConfirmDialog";
import { consoleButtonClass } from "./host-ui";
import { QrCode } from "./QrCode";
import { StatusPill } from "./ui";

/*
 * 通訳を始める (#181): the host's way into 対面通訳 from a booking. Pressing it asks the BFF
 * for a room; the same place then shows ① the guest's QR (their invite URL, which their iPhone
 * opens as an App Clip), ② 自分の iPhone で開く (the host's own invite: a link on an iPhone, the
 * host's own QR anywhere else), ③ 参加状況, read again every 3 seconds while the page is
 * visible, and ④ 通訳を終了, confirmed in a <dialog>. The invite codes exist here only inside
 * the URLs the QRs encode: nothing writes them out, logs them or sends them anywhere else.
 */

/** 参加状況 is read again this often while the page is visible. */
export const TRANSLATE_POLL_MS = 3000;
const IPHONE = /iPhone|iPad|iPod/;

type Room = HostTranslateRoomResponse["room"];
type RoomStatus = HostTranslateRoomStatusResponse;

function startError(status: number): string {
  if (status === 401) return "ログイン状態を確認できません。ページを再読み込みして、必要なら NIHO でログインし直してください。";
  if (status === 403) return "この予約で通訳を始める権限がありません。提供者を切り替えるか、権限を確認してください。";
  if (status === 404) return "この予約では通訳を始められません。";
  if (status === 409) return "いまは通訳の部屋を作れません。しばらくしてからもう一度お試しください。";
  return "通訳を始められませんでした。通信を確認して、もう一度お試しください。";
}

function endError(status: number): string {
  if (status === 401 || status === 403) return "権限を確認できません。ページを再読み込みしてください。";
  if (status === 404) return "この通訳はすでに終了しています。";
  return "通訳を終了できませんでした。通信を確認して、もう一度お試しください。";
}

function EndDialog({ onConfirm, onClose }: { onConfirm: () => void; onClose: () => void }) {
  const stay = useRef<HTMLButtonElement>(null);
  return (
    <HostConfirmDialog
      title="通訳を終了しますか？"
      description="2 人の通訳が止まり、この QR では参加できなくなります。"
      focusRef={stay}
      stayRef={stay}
      confirm={<button type="submit" className={DANGER_BUTTON}>通訳を終了する</button>}
      onConfirm={onConfirm}
      onClose={onClose}
    />
  );
}

export interface HostTranslatePanelProps {
  providerId: string;
  bookingId: string;
  /** While another action on the booking is running. */
  disabled?: boolean;
  className?: string;
  /** The live booking screen also clears its booking details when NIHO revokes access. */
  onAuthorizationEnded?: (status: 401 | 403) => void;
}

export function HostTranslatePanel({ providerId, bookingId, disabled = false, className = "", onAuthorizationEnded }: HostTranslatePanelProps) {
  const base = `translate/providers/${encodeURIComponent(providerId)}/bookings/${encodeURIComponent(bookingId)}/rooms`;
  const [room, setRoom] = useState<Room | null>(null);
  const [status, setStatus] = useState<RoomStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [authorizationEnded, setAuthorizationEnded] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  /** The last 参加状況 could not be read; the one shown is the last that could. */
  const [stale, setStale] = useState(false);
  const [asking, setAsking] = useState(false);
  const [ownQr, setOwnQr] = useState(false);
  // Decided once, in the browser. The first render (the button alone) does not depend on it.
  const [onIphone] = useState(() => typeof navigator !== "undefined" && IPHONE.test(navigator.userAgent));
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const ended = status?.state === "ended";
  const live = room !== null && !ended;
  const revokeAccess = useCallback((responseStatus: 401 | 403) => {
    setAuthorizationEnded(true);
    setRoom(null);
    setStatus(null);
    setStale(false);
    setOwnQr(false);
    setAsking(false);
    setNotice("");
    setError(startError(responseStatus));
    onAuthorizationEnded?.(responseStatus);
  }, [onAuthorizationEnded]);

  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  // A room was just made: its heading takes focus (the button that was pressed is gone).
  useEffect(() => { if (room) headingRef.current?.focus(); }, [room]);

  // ③ 参加状況: every 3 seconds while the page is visible, nothing while it is hidden, until the room ends.
  useEffect(() => {
    if (!room || ended) return;
    let active = true;
    let running = false;
    let timer: number | undefined;
    const controller = new AbortController();
    const path = `${base}/${encodeURIComponent(room.id)}`;
    const read = async () => {
      let response: Response;
      try { response = await hostFetch(path, { signal: controller.signal }); } catch { if (active) setStale(true); return; }
      if (!active) return;
      if (response.status === 401 || response.status === 403) {
        active = false;
        controller.abort();
        window.clearTimeout(timer);
        revokeAccess(response.status);
        return;
      }
      if (response.status === 404) {
        // NIHO no longer has the room: it ended or expired on its side.
        setStatus((current) => ({ state: "ended", host: current?.host ?? NOT_JOINED, guest: current?.guest ?? NOT_JOINED, usageMinutes: current?.usageMinutes ?? 0 }));
        setNotice("通訳は終了しています。");
        return;
      }
      if (!response.ok) { setStale(true); return; }
      let value: RoomStatus;
      try { value = await response.json() as RoomStatus; } catch { if (active) setStale(true); return; }
      if (!active) return;
      setStatus(value); setStale(false);
    };
    const tick = async () => {
      if (!active || running) return;
      running = true;
      try { await read(); } finally { running = false; }
      if (active && document.visibilityState === "visible") {
        window.clearTimeout(timer);
        timer = window.setTimeout(() => void tick(), TRANSLATE_POLL_MS);
      }
    };
    const onVisibility = () => {
      if (!active) return;
      window.clearTimeout(timer);
      if (document.visibilityState === "visible") void tick();
    };
    document.addEventListener("visibilitychange", onVisibility);
    if (document.visibilityState === "visible") void tick();
    return () => {
      active = false;
      controller.abort();
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [base, room, ended, revokeAccess]);

  const start = async () => {
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await hostFetch(base, { method: "POST" });
      if (response.status === 401 || response.status === 403) { revokeAccess(response.status); return; }
      if (!response.ok) { setError(startError(response.status)); return; }
      const value = await response.json() as HostTranslateRoomResponse;
      setRoom(value.room); setStatus(null); setStale(false); setOwnQr(false);
    } catch {
      setError(startError(0));
    } finally {
      setBusy(false);
    }
  };

  const end = async () => {
    if (!room) return;
    setBusy(true); setError("");
    try {
      const response = await hostFetch(`${base}/${encodeURIComponent(room.id)}/end`, { method: "POST" });
      if (response.status === 401 || response.status === 403) { revokeAccess(response.status); return; }
      if (!response.ok) { setError(endError(response.status)); return; }
      const value = await response.json() as HostTranslateRoomEndResponse;
      setStatus((current) => ({ state: value.state, host: current?.host ?? NOT_JOINED, guest: current?.guest ?? NOT_JOINED, usageMinutes: current?.usageMinutes ?? 0 }));
      setNotice("通訳を終了しました。");
    } catch {
      setError(endError(0));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={className}>
      {error ? <p ref={errorRef} tabIndex={-1} role="alert" className="mb-2.5 rounded-xl bg-danger-pale px-3 py-2 text-[0.8125rem] leading-normal font-bold text-danger focus:outline-none">{error}</p> : null}
      {notice ? <p role="status" className="mb-2.5 rounded-xl bg-leaf-pale px-3 py-2 text-[0.8125rem] leading-normal font-bold text-moss">{notice}</p> : null}
      {!live && !authorizationEnded ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <button type="button" disabled={disabled || busy} onClick={() => void start()} className={consoleButtonClass("primary")}>
            {busy ? "準備しています…" : "通訳を始める"}
          </button>
          <p className="text-[0.78125rem] leading-normal text-muted">日英の対面通訳。2 人とも iPhone とマイク付きイヤフォンを使います。</p>
        </div>
      ) : live ? (
        <section aria-labelledby={headingId} className="rounded-xl border border-line p-3.5">
          <div className="flex items-center justify-between gap-2">
            <h3 id={headingId} ref={headingRef} tabIndex={-1} className="font-sans text-[0.9375rem] leading-normal font-extrabold tracking-normal focus:outline-none">
              対面通訳
            </h3>
            <StatusPill status={TRANSLATE_ROOM_STATUS[status?.state ?? room.state]} />
          </div>
          {/* ① The QR the other person reads; ② the host's own way in. */}
          <div className="mt-3 grid gap-3 sm:grid-cols-[160px_minmax(0,1fr)] sm:items-start">
            <QrCode
              value={ownQr ? room.hostInviteUrl : room.guestInviteUrl}
              label={ownQr ? "自分用の招待 QR コード" : "ゲスト用の招待 QR コード"}
              className="mx-auto w-full max-w-[160px] rounded-lg border border-line bg-canvas p-2 sm:mx-0"
            />
            <div className="min-w-0">
              <p className="font-extrabold">{ownQr ? "自分の iPhone で読み取ってください" : "相手に読み取ってもらってください"}</p>
              <p className="mt-1 text-[0.8125rem] leading-normal text-ink-soft">
                {ownQr ? "読み取ると、あなたの iPhone で通訳の画面が開きます。" : "読み取ると、相手の iPhone で参加の画面が開きます。アプリのインストールは要りません。"}
              </p>
              <p className="mt-1 text-xs text-muted">QR は {timeInJapan(room.expiresAt)} まで使えます</p>
              <div className="mt-2.5 flex flex-wrap gap-2">
                {onIphone ? (
                  <a href={room.hostInviteUrl} rel="noreferrer" className={consoleButtonClass("primary")}>自分の iPhone で開く</a>
                ) : (
                  <button type="button" aria-pressed={ownQr} onClick={() => setOwnQr((value) => !value)} className={consoleButtonClass(ownQr ? "secondary" : "primary")}>
                    {ownQr ? "ゲスト用 QR に戻す" : "自分の iPhone で開く"}
                  </button>
                )}
              </div>
            </div>
          </div>
          {/* ③ Who has joined. */}
          <dl aria-label="参加状況" className="mt-3 grid grid-cols-2 gap-2 border-t border-line pt-3">
            {(["host", "guest"] as const).map((role) => (
              <div key={role} className="flex min-w-0 flex-wrap items-center justify-between gap-1.5">
                <dt className="text-[0.8125rem] font-bold">{role === "host" ? "ホスト" : "ゲスト"}</dt>
                <dd><StatusPill status={participantStatus(status?.[role])} /></dd>
              </div>
            ))}
          </dl>
          <p className="mt-1.5 text-xs text-muted">
            {status ? `使用 ${status.usageMinutes} 分` : "参加状況を確認しています…"}
            {stale ? " · いまは参加状況を更新できません" : ""}
          </p>
          {/* ④ */}
          <div className="mt-3 border-t border-line pt-3">
            <button type="button" disabled={busy} onClick={() => setAsking(true)} className={DANGER_BUTTON}>通訳を終了</button>
          </div>
        </section>
      ) : null}
      {asking ? <EndDialog onConfirm={() => void end()} onClose={() => setAsking(false)} /> : null}
    </div>
  );
}
