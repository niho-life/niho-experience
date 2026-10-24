"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { sessionCancelConfirmLabel, sessionCancelMessage, sessionCancelSummary, SESSION_CANCEL_REASONS, type SessionCancelPlan, type SessionCancelReason } from "@/host/session";
import type { StatusLabel } from "@/host/status";
import { DISABLED } from "./editor-parts";
import { CHOICE, CHOICE_INPUT, DANGER_BUTTON, GROUP_LABEL } from "./HostBookingDialogs";
import { HOST_DIALOG, HostConfirmDialog } from "./HostConfirmDialog";
import { consoleButtonClass } from "./host-ui";
import { StatusPill } from "./ui";

/*
 * この回 (#107)'s dialogs, modal <dialog>s on the page like the bookings screen's. 参加者に連絡する
 * only leads to each guest's thread (#106): there is no message to everyone. この回を中止 asks for
 * a reason first and says what it will do; nothing happens until its own button is pressed.
 */

/** A guest 参加者に連絡する lists. */
export interface SessionContact {
  id: string;
  guest: string;
  /** "2名" */
  people: string;
  /** The booking's state when it is not 確定 (承認待ち, 取消済み); null for a booking. */
  status: StatusLabel | null;
  /** The booking's thread, or an empty one to start. */
  href: string;
}

/** 参加者に連絡する: each guest with メッセージを開く. Esc and 閉じる close it. */
export function SessionContactDialog({ contacts, onClose }: { contacts: readonly SessionContact[]; onClose: () => void }) {
  const baseId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const element = dialog.current;
    // Opened once: removing the element when the dialog is done closes it without a "close" event.
    if (element && !element.open) element.showModal();
    close.current?.focus();
  }, []);
  return (
    <dialog ref={dialog} aria-labelledby={`${baseId}-title`} aria-describedby={`${baseId}-body`} onClose={onClose} className={HOST_DIALOG}>
      <div className="flex max-h-[calc(100dvh-2rem)] flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-4 pb-3 md:px-5 md:pt-5">
          <h2 id={`${baseId}-title`} className="font-sans text-[0.9375rem] leading-normal font-extrabold tracking-normal">
            参加者に連絡する
          </h2>
          <p id={`${baseId}-body`} className="mt-1 text-ink-soft">
            連絡は 1 人ずつ送ります
          </p>
          <ul className="mt-3">
            {contacts.map((contact) => (
              <li key={contact.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-line py-2.5 first:border-t-0">
                <span id={`${baseId}-${contact.id}`} className="min-w-0 flex-[1_1_140px]">
                  <span className="block text-[0.875rem] leading-[1.4] font-extrabold [overflow-wrap:anywhere]">{contact.guest}</span>
                  <span className="block text-[0.78125rem] leading-normal text-muted">{contact.people}</span>
                </span>
                {contact.status ? <StatusPill status={contact.status} /> : null}
                <Link href={contact.href} aria-describedby={`${baseId}-${contact.id}`} className={consoleButtonClass("secondary", "sm", "max-md:ml-auto")}>
                  メッセージを開く
                </Link>
              </li>
            ))}
          </ul>
        </div>
        <div className="flex justify-end border-t border-line px-4 py-3 md:px-5">
          <button ref={close} type="button" onClick={() => dialog.current?.close()} className={consoleButtonClass("secondary")}>
            閉じる
          </button>
        </div>
      </div>
    </dialog>
  );
}

/**
 * この回を中止: the reason (雨・荒天・急病・けが・その他の事情; NIHO adds its fixed words to the cancellation
 * email, no free text), then what it cancels and refunds. The button names the result and waits
 * for a reason.
 */
export function SessionCancelDialog({ when, plan, onConfirm, onClose }: { when: string; plan: SessionCancelPlan; onConfirm: (reason: SessionCancelReason) => void; onClose: () => void }) {
  const baseId = useId();
  const [reason, setReason] = useState<SessionCancelReason | null>(null);
  const first = useRef<HTMLInputElement>(null);
  const hintId = `${baseId}-waiting`;
  return (
    <HostConfirmDialog
      title="この回を中止しますか？"
      description={`${when}の回を中止します。この操作は元に戻せません。`}
      focusRef={first}
      hint={
        reason ? null : (
          <p id={hintId} className="basis-full text-xs text-muted">
            中止の理由を選ぶと中止できます
          </p>
        )
      }
      confirm={
        <button type="submit" disabled={!reason} aria-describedby={reason ? undefined : hintId} className={`${DANGER_BUTTON} ${DISABLED}`}>
          {sessionCancelConfirmLabel(plan)}
        </button>
      }
      onConfirm={() => {
        if (reason) onConfirm(reason);
      }}
      onClose={onClose}
    >
      <fieldset className="mt-4 min-w-0">
        <legend className={GROUP_LABEL}>中止の理由</legend>
        <div className="flex flex-wrap gap-2">
          {SESSION_CANCEL_REASONS.map((item, index) => (
            <label key={item.value} className={`${CHOICE} inline-flex h-9 items-center rounded-full px-3.5 text-[0.8125rem] font-extrabold`}>
              <input
                ref={index === 0 ? first : undefined}
                type="radio"
                name={`${baseId}-reason`}
                value={item.value}
                checked={reason === item.value}
                onChange={() => setReason(item.value)}
                className={`${CHOICE_INPUT} rounded-full`}
              />
              {item.label}
            </label>
          ))}
        </div>
        {reason ? <p className="mt-2 text-xs text-muted">メールに添える文: {sessionCancelMessage("ja", reason)}</p> : null}
      </fieldset>
      <div className="mt-4 rounded-xl bg-sand px-3 py-2.5 text-[0.8125rem] leading-normal">
        <p className="font-bold">{sessionCancelSummary(plan)}</p>
        <p className="mt-1 text-ink-soft">予約者には取消のメールに理由を添えて送ります（自由文は送れません）。</p>
      </div>
    </HostConfirmDialog>
  );
}
