"use client";

import { useId, useRef, useState, useTransition, type FormEvent } from "react";
import { cancelNotificationAddress, requestNotificationAddress, restoreLoginNotificationAddress } from "@/host/actions";
import { NOTIFICATION_ADDRESS_TEXT, notificationAddressInput, notificationAddressSourceText, type HostNotificationAddressView } from "@/host/notification-address";
import type { HostNotice } from "@/host/payout";
import { DISABLED } from "./editor-parts";
import { INPUT, NARROW } from "./fields";
import { consoleButtonClass } from "./host-ui";
import { HostNoticeLine } from "./HostNoticeLine";

/**
 * 設定 › 通知 › 宛先 (#194, owner decision 2026-11-01): the address this site emails the signed-in person, and where it came
 * from. 宛先を変える asks for a new address and 確認のメールを送る sends a link to it: nothing changes until the link is opened
 * (an hour, once). While one waits, 取り消す closes its link; a chosen address can go back to the sign-in's. Like カレンダー,
 * it works on its own (not through the page's 保存) and says how it went inside the panel. The preview keeps every change on
 * this screen and sends nothing.
 */
export function HostNotificationAddress({ providerId, initial, labelId }: { providerId: string; initial: HostNotificationAddressView; labelId: string }) {
  const ids = useId();
  const inputId = `${ids}-email`;
  const [view, setView] = useState(initial);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [invalid, setInvalid] = useState(false);
  const [notice, setNotice] = useState<HostNotice | null>(null);
  const [busy, startBusy] = useTransition();
  const opener = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);

  const done = (result: { ok: true; message: string; address: HostNotificationAddressView } | { ok: false; message: string }) => {
    if (result.ok) {
      setView(result.address);
      setNotice({ tone: "success", message: result.message });
      return true;
    }
    setNotice({ tone: "error", message: result.message });
    return false;
  };

  const startEditing = () => {
    setEditing(true);
    setDraft("");
    setInvalid(false);
    setNotice(null);
    // After the field renders.
    requestAnimationFrame(() => input.current?.focus());
  };

  const stopEditing = () => {
    setEditing(false);
    setInvalid(false);
    requestAnimationFrame(() => opener.current?.focus());
  };

  const send = (event: FormEvent) => {
    event.preventDefault();
    const email = notificationAddressInput(draft);
    if (!email) {
      setInvalid(true);
      input.current?.focus();
      return;
    }
    if (view.preview) {
      const same = (other: string | null) => other !== null && other.toLowerCase() === email.toLowerCase();
      if (same(view.effective)) done({ ok: true, message: NOTIFICATION_ADDRESS_TEXT.unchanged, address: { ...view, pending: null } });
      else if (same(view.login)) done({ ok: true, message: NOTIFICATION_ADDRESS_TEXT.backToLogin, address: { ...view, effective: view.login, source: "login", pending: null } });
      else done({ ok: true, message: NOTIFICATION_ADDRESS_TEXT.previewPending(email), address: { ...view, pending: email } });
      stopEditing();
      return;
    }
    startBusy(async () => {
      if (done(await requestNotificationAddress({ providerId, email }))) stopEditing();
    });
  };

  const cancel = () => {
    if (view.preview) {
      done({ ok: true, message: NOTIFICATION_ADDRESS_TEXT.cancelled, address: { ...view, pending: null } });
      return;
    }
    startBusy(async () => {
      done(await cancelNotificationAddress());
    });
  };

  const backToLogin = () => {
    if (view.preview) {
      done({ ok: true, message: NOTIFICATION_ADDRESS_TEXT.backToLogin, address: { ...view, effective: view.login, source: view.login ? "login" : null, pending: null } });
      return;
    }
    startBusy(async () => {
      done(await restoreLoginNotificationAddress());
    });
  };

  const errorId = `${ids}-error`;
  return (
    <div role="group" aria-labelledby={labelId} aria-busy={busy} className="flex min-h-10 flex-col justify-center gap-1.5">
      <div>
        {view.effective ? <p className="font-extrabold [overflow-wrap:anywhere]">{view.effective}</p> : null}
        <p className="text-ink-soft">{notificationAddressSourceText(view)}</p>
      </div>
      {view.pending ? (
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-[10px] bg-warn-pale px-3 py-2 text-[0.8125rem] text-ink">
          <p className="min-w-0 flex-1 basis-56 [overflow-wrap:anywhere]">
            {view.preview ? NOTIFICATION_ADDRESS_TEXT.previewPending(view.pending) : NOTIFICATION_ADDRESS_TEXT.pending(view.pending)}
          </p>
          <button type="button" className={consoleButtonClass("ghost", "sm", DISABLED)} disabled={busy} onClick={cancel}>
            取り消す
          </button>
        </div>
      ) : null}
      {editing ? (
        <form className="flex flex-col gap-2" onSubmit={send} noValidate>
          <label htmlFor={inputId} className="text-[0.78125rem] font-extrabold text-ink-soft">
            新しい宛先
          </label>
          <input
            ref={input}
            id={inputId}
            type="email"
            inputMode="email"
            autoComplete="email"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={254}
            value={draft}
            aria-invalid={invalid || undefined}
            aria-describedby={invalid ? errorId : undefined}
            onChange={(event) => {
              setDraft(event.target.value);
              setInvalid(false);
            }}
            className={`${INPUT} ${NARROW}`}
          />
          {invalid ? (
            <p id={errorId} className="text-[0.78125rem] font-extrabold text-danger">
              {NOTIFICATION_ADDRESS_TEXT.invalid}
            </p>
          ) : null}
          <p className="text-xs leading-normal text-muted">このアドレスに確認のメールを送ります。メールのリンクを開くまで、宛先は変わりません。</p>
          <div className="flex flex-wrap items-center gap-2.5">
            <button type="submit" className={consoleButtonClass("primary", "sm", DISABLED)} disabled={busy}>
              {busy ? "送っています…" : "確認のメールを送る"}
            </button>
            <button type="button" className={consoleButtonClass("ghost", "sm", DISABLED)} disabled={busy} onClick={stopEditing}>
              やめる
            </button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap items-center gap-2.5">
          <button ref={opener} type="button" className={consoleButtonClass("secondary", "sm", DISABLED)} disabled={busy} onClick={startEditing}>
            宛先を変える
          </button>
          {view.source === "chosen" && view.login ? (
            <button type="button" className={consoleButtonClass("ghost", "sm", `${DISABLED} max-w-full [overflow-wrap:anywhere]`)} disabled={busy} onClick={backToLogin}>
              ログインのメールに戻す
            </button>
          ) : null}
        </div>
      )}
      <HostNoticeLine notice={notice} />
    </div>
  );
}
