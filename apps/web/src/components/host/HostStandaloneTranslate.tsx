"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  standaloneLanguageLabel,
  standaloneInviteExpiryDelay,
  standaloneInviteUsable,
  standaloneParticipant,
  standaloneResponseIsCurrent,
  standaloneTranslateErrorText,
  standaloneTranslateBffPath,
  type HostStandaloneTranslateCreated,
  type HostStandaloneTranslateCurrent,
  type HostStandaloneTranslateInvite,
  type HostStandaloneTranslateInviteResult,
  type HostStandaloneTranslateLanguage,
  type HostStandaloneTranslateRoom,
} from "@/host/standalone-translate";
import { participantStatus, timeInJapan, TRANSLATE_ROOM_STATUS } from "@/host/translate";
import { hostFetch } from "@/lib/host/client-session";
import { HOST_LOGIN_PATH, withProvider } from "@/lib/host/routes";
import { DANGER_BUTTON } from "./HostBookingDialogs";
import { HostConfirmDialog } from "./HostConfirmDialog";
import { consoleButtonClass, HOST_SURFACE } from "./host-ui";
import { QrCode } from "./QrCode";
import { StatusPill } from "./ui";

export const STANDALONE_TRANSLATE_POLL_MS = 3000;
type Role = "host" | "guest";
type Invites = Record<Role, HostStandaloneTranslateInvite | null>;
const EMPTY_INVITES: Invites = { host: null, guest: null };

function ConfirmAction({ kind, role, onConfirm, onClose }: { kind: "end" | "reissue"; role?: Role; onConfirm: () => void; onClose: () => void }) {
  const stay = useRef<HTMLButtonElement>(null);
  const reissue = kind === "reissue";
  return (
    <HostConfirmDialog
      title={reissue ? `${role === "host" ? "自分" : "相手"}用の招待を再発行しますか？` : "通訳を終了しますか？"}
      description={reissue ? "この席の古い招待と接続は使えなくなります。もう一方の席と部屋はそのままです。" : "2人の通訳が止まり、このQRとアプリリンクは使えなくなります。"}
      focusRef={stay}
      stayRef={stay}
      confirm={<button type="submit" className={reissue ? consoleButtonClass("primary") : DANGER_BUTTON}>{reissue ? "再発行する" : "通訳を終了する"}</button>}
      onConfirm={onConfirm}
      onClose={onClose}
    />
  );
}

export function HostStandaloneTranslate({ providerId, providerName }: { providerId: string; providerName: string }) {
  const base = standaloneTranslateBffPath(providerId);
  const [language, setLanguage] = useState<HostStandaloneTranslateLanguage>("ja");
  const [room, setRoom] = useState<HostStandaloneTranslateRoom | null>(null);
  const [invites, setInvites] = useState<Invites>(EMPTY_INVITES);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  const [authorizationEnded, setAuthorizationEnded] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [inviteNow, setInviteNow] = useState(() => Date.now());
  const [confirming, setConfirming] = useState<{ kind: "end" } | { kind: "reissue"; role: Role } | null>(null);
  const instance = useRef(0);
  const roomId = useRef<string | null>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => { roomId.current = room?.roomId ?? null; }, [room]);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);

  const revoke = useCallback((status: 401 | 403) => {
    instance.current += 1;
    roomId.current = null;
    setRoom(null);
    setInvites(EMPTY_INVITES);
    setBusy(false);
    setLoading(false);
    setAuthorizationEnded(true);
    setConfirming(null);
    setStale(false);
    setNotice("");
    setError(standaloneTranslateErrorText(status, "load"));
  }, []);

  const clearEndedRoom = useCallback((message: string) => {
    roomId.current = null;
    setRoom(null);
    setInvites(EMPTY_INVITES);
    setBusy(false);
    setConfirming(null);
    setStale(false);
    setNotice(message);
  }, []);

  const readCurrent = useCallback(async (generation: number, signal?: AbortSignal): Promise<boolean> => {
    let response: Response;
    try { response = await hostFetch(`${base}/current`, { signal }); }
    catch { return false; }
    if (!standaloneResponseIsCurrent(generation, instance.current) || signal?.aborted) return false;
    if (response.status === 401 || response.status === 403) { revoke(response.status); return false; }
    if (!response.ok) return false;
    try {
      const value = await response.json() as HostStandaloneTranslateCurrent;
      if (!standaloneResponseIsCurrent(generation, instance.current) || signal?.aborted) return false;
      setRoom(value.room);
      roomId.current = value.room?.roomId ?? null;
      setInvites(EMPTY_INVITES);
      setStale(false);
      return true;
    } catch { return false; }
  }, [base, revoke]);

  // Initial load and provider changes recover only the current room. Invite URLs are never persisted or auto-reissued.
  useEffect(() => {
    const generation = instance.current + 1;
    instance.current = generation;
    const controller = new AbortController();
    queueMicrotask(() => {
      if (generation !== instance.current || controller.signal.aborted) return;
      setLoading(true); setRoom(null); setInvites(EMPTY_INVITES); setAuthorizationEnded(false); setBusy(false); setConfirming(null); setStale(false); setError(""); setNotice(""); setInviteNow(Date.now());
    });
    void readCurrent(generation, controller.signal).then((ok) => {
      if (generation !== instance.current || controller.signal.aborted) return;
      setLoading(false);
      if (!ok) setError("通訳の状態を読み込めませんでした。通信を確認して、ページを再読み込みしてください。");
    });
    return () => { instance.current += 1; controller.abort(); };
  }, [providerId, readCurrent]);

  const hostInviteExpiresAt = invites.host?.expiresAt;
  const guestInviteExpiresAt = invites.guest?.expiresAt;
  // Invite expiry is independent of status polling: it still removes stale QR/href while offline,
  // and a tab returning to the foreground re-evaluates against the current wall clock immediately.
  useEffect(() => {
    let timer: number | undefined;
    const refresh = () => setInviteNow(Date.now());
    const onVisibility = () => { if (document.visibilityState === "visible") refresh(); };
    const delay = standaloneInviteExpiryDelay([invites.host, invites.guest], Date.now());
    if (delay !== null) timer = window.setTimeout(refresh, delay);
    document.addEventListener("visibilitychange", onVisibility);
    return () => { window.clearTimeout(timer); document.removeEventListener("visibilitychange", onVisibility); };
  }, [guestInviteExpiresAt, hostInviteExpiresAt, inviteNow, invites.guest, invites.host]);

  // Participant status: visible-only, one request at a time, stopped after ended/unmount/provider switch.
  const activeRoomId = room?.roomId;
  const activeRoomState = room?.state;
  useEffect(() => {
    if (!activeRoomId || activeRoomState === "ended" || authorizationEnded) return;
    const expectedRoomId = activeRoomId;
    const generation = instance.current;
    const controller = new AbortController();
    let active = true;
    let running = false;
    let timer: number | undefined;
    const read = async () => {
      let response: Response;
      try { response = await hostFetch(`${base}/${encodeURIComponent(expectedRoomId)}`, { signal: controller.signal }); }
      catch { if (active && generation === instance.current) setStale(true); return; }
      if (!active || !standaloneResponseIsCurrent(generation, instance.current, expectedRoomId, roomId.current)) return;
      if (response.status === 401 || response.status === 403) { revoke(response.status); return; }
      if (response.status === 404) {
        clearEndedRoom("通訳は終了しています。");
        return;
      }
      if (!response.ok) { setStale(true); return; }
      try {
        const value = await response.json() as HostStandaloneTranslateRoom;
        if (!active || !standaloneResponseIsCurrent(generation, instance.current, expectedRoomId, roomId.current)) return;
        if (value.roomId !== expectedRoomId) { setStale(true); return; }
        if (value.state === "ended") clearEndedRoom("通訳は終了しています。");
        else setRoom(value);
        setStale(false);
      } catch { if (active) setStale(true); }
    };
    const tick = async () => {
      if (!active || running) return;
      running = true;
      try { await read(); } finally { running = false; }
      if (active && generation === instance.current && document.visibilityState === "visible") timer = window.setTimeout(() => void tick(), STANDALONE_TRANSLATE_POLL_MS);
    };
    const visible = () => { window.clearTimeout(timer); if (active && document.visibilityState === "visible") void tick(); };
    document.addEventListener("visibilitychange", visible);
    if (document.visibilityState === "visible") void tick();
    return () => { active = false; controller.abort(); window.clearTimeout(timer); document.removeEventListener("visibilitychange", visible); };
  }, [activeRoomId, activeRoomState, authorizationEnded, base, clearEndedRoom, revoke]);

  const recoverAfterCreate = async (generation: number) => {
    const recovered = await readCurrent(generation);
    if (generation !== instance.current) return;
    setBusy(false);
    if (recovered && roomId.current) setNotice("進行中の通訳を復元しました。招待は必要な席だけ再発行してください。");
    else if (!authorizationEnded) setError("作成結果を確認できませんでした。ページを再読み込みしてから、進行中の部屋を確認してください。");
  };

  const create = async () => {
    if (busy || loading || room) return;
    const generation = instance.current;
    setBusy(true); setError(""); setNotice("");
    let response: Response;
    try { response = await hostFetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hostLanguage: language }) }); }
    catch { await recoverAfterCreate(generation); return; }
    if (generation !== instance.current) return;
    if (response.status === 401 || response.status === 403) { setBusy(false); revoke(response.status); return; }
    if (response.status === 409) { await recoverAfterCreate(generation); return; }
    // A relay/network 5xx does not prove whether NIHO committed the POST. Recover current; never post twice.
    if (response.status >= 500) { await recoverAfterCreate(generation); return; }
    if (!response.ok) { setBusy(false); setError(standaloneTranslateErrorText(response.status, "create")); return; }
    try {
      const value = await response.json() as HostStandaloneTranslateCreated;
      if (generation !== instance.current) return;
      roomId.current = value.room.roomId;
      setRoom(value.room); setInvites({ host: value.host, guest: value.guest }); setInviteNow(Date.now()); setBusy(false); setStale(false);
    } catch { await recoverAfterCreate(generation); }
  };

  const reissue = async (role: Role) => {
    if (!room || busy) return;
    const expectedRoomId = room.roomId;
    const generation = instance.current;
    setConfirming(null); setBusy(true); setError(""); setNotice("");
    try {
      const response = await hostFetch(`${base}/${encodeURIComponent(expectedRoomId)}/invites/${role}`, { method: "POST" });
      if (!standaloneResponseIsCurrent(generation, instance.current, expectedRoomId, roomId.current)) return;
      if (response.status === 401 || response.status === 403) { setBusy(false); revoke(response.status); return; }
      if (!response.ok) { setBusy(false); setError(standaloneTranslateErrorText(response.status, "invite")); return; }
      const value = await response.json() as HostStandaloneTranslateInviteResult;
      if (!standaloneResponseIsCurrent(generation, instance.current, expectedRoomId, roomId.current)) return;
      if (value.roomId !== expectedRoomId || value.role !== role) {
        setBusy(false); setError(standaloneTranslateErrorText(0, "invite")); return;
      }
      setInvites((current) => ({ ...current, [role]: value.invite }));
      setInviteNow(Date.now());
      setBusy(false); setNotice(`${role === "host" ? "自分" : "相手"}用の招待を再発行しました。古い招待は使えません。`);
    } catch { if (standaloneResponseIsCurrent(generation, instance.current, expectedRoomId, roomId.current)) { setBusy(false); setError(standaloneTranslateErrorText(0, "invite")); } }
  };

  const requestReissue = (role: Role) => {
    if (standaloneParticipant(room, role).joined) setConfirming({ kind: "reissue", role });
    else void reissue(role);
  };

  const end = async () => {
    if (!room || busy) return;
    const expectedRoomId = room.roomId;
    const generation = instance.current;
    setConfirming(null); setBusy(true); setError("");
    try {
      const response = await hostFetch(`${base}/${encodeURIComponent(expectedRoomId)}/end`, { method: "POST" });
      if (!standaloneResponseIsCurrent(generation, instance.current, expectedRoomId, roomId.current)) return;
      if (response.status === 401 || response.status === 403) { setBusy(false); revoke(response.status); return; }
      if (!response.ok) { setBusy(false); setError(standaloneTranslateErrorText(response.status, "end")); return; }
      clearEndedRoom("通訳を終了しました。招待とQRは使えません。");
    } catch { if (standaloneResponseIsCurrent(generation, instance.current, expectedRoomId, roomId.current)) { setBusy(false); setError(standaloneTranslateErrorText(0, "end")); } }
  };

  const guestInvite = standaloneInviteUsable(invites.guest, inviteNow) ? invites.guest : null;
  const hostInvite = standaloneInviteUsable(invites.host, inviteNow) ? invites.host : null;

  return (
    <div className="mx-auto w-full max-w-2xl space-y-3.5">
      <section className={HOST_SURFACE} aria-labelledby="standalone-provider">
        <div className="p-4 md:p-5">
          <h2 id="standalone-provider" className="font-sans text-[0.9375rem] leading-normal font-extrabold tracking-normal">{providerName} 名義</h2>
          <p className="mt-1 text-[0.8125rem] leading-normal text-ink-soft">2人とも対応するNIHOアプリと、マイク付きイヤフォンを使います。予約は必要ありません。</p>
        </div>
      </section>

      {error ? <p ref={errorRef} tabIndex={-1} role="alert" className="rounded-xl bg-danger-pale px-3 py-2 text-[0.8125rem] font-bold text-danger focus:outline-none">{error}</p> : null}
      {notice ? <p role="status" className="rounded-xl bg-leaf-pale px-3 py-2 text-[0.8125rem] font-bold text-moss">{notice}</p> : null}
      {authorizationEnded ? <a href={withProvider(HOST_LOGIN_PATH, providerId)} className={consoleButtonClass("primary")}>NIHOでログインし直す</a> : null}

      {!authorizationEnded && !room ? (
        <section className={HOST_SURFACE} aria-labelledby="standalone-language">
          <div className="p-4 md:p-5">
            <h2 id="standalone-language" className="font-sans text-[0.9375rem] leading-normal font-extrabold tracking-normal">自分が話す言語</h2>
            <div className="mt-3 grid grid-cols-2 gap-2" role="radiogroup" aria-labelledby="standalone-language">
              {(["ja", "en"] as const).map((value) => (
                <label key={value} className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 font-bold ${language === value ? "border-ink bg-sand" : "border-line"}`}>
                  <input type="radio" name="host-language" value={value} checked={language === value} onChange={() => setLanguage(value)} disabled={loading || busy} />
                  {standaloneLanguageLabel(value)}
                </label>
              ))}
            </div>
            <p className="mt-2 text-xs text-muted">相手の言語は {standaloneLanguageLabel(language === "ja" ? "en" : "ja")} になります。</p>
            <button type="button" disabled={loading || busy} onClick={() => void create()} className={`${consoleButtonClass("primary")} mt-4 min-h-12 w-full`}>
              {loading ? "進行中の通訳を確認しています…" : busy ? "部屋を準備しています…" : "通訳の部屋を作る"}
            </button>
          </div>
        </section>
      ) : room ? (
        <section className={HOST_SURFACE} aria-labelledby="standalone-room">
          <div className="p-4 md:p-5">
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
              <h2 id="standalone-room" className="font-sans text-[0.9375rem] leading-normal font-extrabold tracking-normal">通訳の部屋</h2>
              <StatusPill status={TRANSLATE_ROOM_STATUS[room.state]} />
            </div>
            <p className="mt-1 text-xs text-muted">部屋は {timeInJapan(room.expiresAt)} まで（最大90分） · 使用 {room.usageMinutes}分{stale ? " · 状況を更新できません" : ""}</p>

            <div className="mt-4 border-t border-line pt-4">
              <h3 className="font-extrabold">相手に参加してもらう</h3>
              {guestInvite ? (
                <div className="mt-3 grid gap-3 sm:grid-cols-[180px_minmax(0,1fr)] sm:items-start">
                  <QrCode value={guestInvite.inviteUrl} label="相手用の招待QRコード" className="mx-auto w-full max-w-[180px] rounded-xl border border-line bg-canvas p-2 sm:mx-0" />
                  <div className="min-w-0">
                    <p className="text-[0.8125rem] leading-normal text-ink-soft">相手のiPhone標準カメラで読み取ると、NIHOアプリが開きます。</p>
                    <p className="mt-1 text-xs text-muted">招待は {timeInJapan(guestInvite.expiresAt)} まで（15分）</p>
                    <button type="button" disabled={busy} onClick={() => requestReissue("guest")} className={`${consoleButtonClass("secondary", "sm")} mt-2.5`}>相手用を再発行</button>
                  </div>
                </div>
              ) : (
                <div className="mt-2">
                  <p className="text-[0.8125rem] leading-normal text-ink-soft">相手用の招待はこの画面に残っていません。必要なときだけ再発行してください。</p>
                  <button type="button" disabled={busy} onClick={() => requestReissue("guest")} className={`${consoleButtonClass("primary")} mt-2.5`}>相手用QRを再発行</button>
                </div>
              )}
            </div>

            <div className="mt-4 border-t border-line pt-4">
              <h3 className="font-extrabold">自分もNIHOアプリで参加する</h3>
              <p className="mt-1 text-[0.8125rem] leading-normal text-ink-soft">相手を待たず、自分が先に入って準備できます。開いても通訳は自動開始しません。</p>
              {hostInvite ? (
                <div className="mt-2.5 flex min-w-0 flex-wrap gap-2">
                  <a href={hostInvite.inviteUrl} rel="noreferrer" className={consoleButtonClass("primary")}>自分のNIHOアプリで開く</a>
                  <button type="button" disabled={busy} onClick={() => requestReissue("host")} className={consoleButtonClass("secondary")}>自分用を再発行</button>
                  <p className="w-full text-xs text-muted">招待は {timeInJapan(hostInvite.expiresAt)} まで（15分）</p>
                </div>
              ) : (
                <button type="button" disabled={busy} onClick={() => requestReissue("host")} className={`${consoleButtonClass("primary")} mt-2.5`}>自分用リンクを再発行</button>
              )}
            </div>

            <dl aria-label="参加状況" className="mt-4 grid gap-2 border-t border-line pt-4 sm:grid-cols-2">
              {(["host", "guest"] as const).map((role) => (
                <div key={role} className="flex min-w-0 items-center justify-between gap-2 rounded-xl bg-sand px-3 py-2">
                  <dt className="text-[0.8125rem] font-bold">{role === "host" ? "自分" : "相手"}</dt>
                  <dd><StatusPill status={participantStatus(standaloneParticipant(room, role))} /></dd>
                </div>
              ))}
            </dl>
            <p className="mt-2 text-xs text-muted">2人の準備後、通訳の開始はNIHOアプリで明示して行います。</p>
            <div className="mt-4 border-t border-line pt-4">
              <button type="button" disabled={busy} onClick={() => setConfirming({ kind: "end" })} className={DANGER_BUTTON}>通訳を終了</button>
            </div>
          </div>
        </section>
      ) : null}

      {confirming ? <ConfirmAction kind={confirming.kind} role={confirming.kind === "reissue" ? confirming.role : undefined} onConfirm={() => confirming.kind === "end" ? void end() : void reissue(confirming.role)} onClose={() => setConfirming(null)} /> : null}
    </div>
  );
}
