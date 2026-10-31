"use client";

import { useId, useRef, useState } from "react";
import { yen } from "@/host/format";
import { SITE_CANCEL_NOTE_MAX, SITE_CANCEL_REASONS, SITE_SESSION_CANCEL_REASONS } from "@/host/site-bookings";
import type { CancellationReason } from "@niho-experience/experience-store";
import { DISABLED, FIELD_LABEL } from "./editor-parts";
import { TEXTAREA } from "./fields";
import { CHOICE, CHOICE_INPUT, DANGER_BUTTON, GROUP_LABEL } from "./HostBookingDialogs";
import { HostConfirmDialog } from "./HostConfirmDialog";

/*
 * 取消 of the bookings made on this site (#285 slice 7): the host always refunds in full (the host's decision), so the
 * dialog asks only why (a fixed reason the guest's email words in English) and an optional note of the host's own,
 * which the guest never sees. Anything but a full refund goes through NIHO support. The dialog closes first and hands
 * the choice to the page, which sends it and says what happened.
 */

export interface SiteCancelChoice {
  reason: CancellationReason;
  note: string;
}

function CancelFields({ reasons, reason, setReason, note, setNote, first }: {
  reasons: readonly { value: CancellationReason; label: string }[];
  reason: CancellationReason | null;
  setReason: (reason: CancellationReason) => void;
  note: string;
  setNote: (note: string) => void;
  first: React.RefObject<HTMLInputElement | null>;
}) {
  const baseId = useId();
  return (
    <>
      <fieldset className="mt-4 min-w-0">
        <legend className={GROUP_LABEL}>取消理由</legend>
        <div className="flex flex-wrap gap-2">
          {reasons.map((item, index) => (
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
        <p className="mt-1.5 text-xs text-muted">予約者へのメールには、選んだ理由を決まった英語で書きます。</p>
      </fieldset>
      <div className="mt-4 flex flex-col gap-1.5">
        <label htmlFor={`${baseId}-note`} className={FIELD_LABEL}>
          メモ（任意・予約者には届きません）
        </label>
        <textarea id={`${baseId}-note`} maxLength={SITE_CANCEL_NOTE_MAX} rows={3} value={note} onChange={(event) => setNote(event.currentTarget.value)} className={TEXTAREA} />
      </div>
    </>
  );
}

/** One booking: 取り消して全額を返金する. */
export function SiteBookingCancelDialog({ guest, when, amountYen, onConfirm, onClose }: {
  guest: string;
  when: string;
  amountYen: number;
  onConfirm: (choice: SiteCancelChoice) => void;
  onClose: () => void;
}) {
  const [reason, setReason] = useState<CancellationReason | null>(null);
  const [note, setNote] = useState("");
  const first = useRef<HTMLInputElement>(null);
  const hintId = useId();
  return (
    <HostConfirmDialog
      title="予約を取り消しますか？"
      description={`${guest}さんの予約（${when}）を取り消し、${yen(amountYen)} を全額返金します。この操作は元に戻せません。`}
      focusRef={first}
      hint={reason ? null : <p id={hintId} className="basis-full text-xs text-muted">取消理由を選ぶと取り消せます</p>}
      confirm={
        <button type="submit" disabled={!reason} aria-describedby={reason ? undefined : hintId} className={`${DANGER_BUTTON} ${DISABLED}`}>
          {yen(amountYen)} を返金して取り消す
        </button>
      }
      onConfirm={() => {
        if (reason) onConfirm({ reason, note });
      }}
      onClose={onClose}
    >
      <p className="mt-3 text-[0.8125rem] text-ink-soft">予約者には取消と返金のお知らせがメールで届きます。一部だけの返金は NIHO サポートへご連絡ください。</p>
      <CancelFields reasons={SITE_CANCEL_REASONS} reason={reason} setReason={setReason} note={note} setNote={setNote} first={first} />
    </HostConfirmDialog>
  );
}

/** A whole session: この回を中止する. */
export function SiteSessionCancelDialog({ when, bookings, refundYen, onConfirm, onClose }: {
  when: string;
  /** Confirmed bookings made here that will be cancelled. */
  bookings: number;
  refundYen: number;
  onConfirm: (choice: SiteCancelChoice) => void;
  onClose: () => void;
}) {
  const [reason, setReason] = useState<CancellationReason | null>(null);
  const [note, setNote] = useState("");
  const first = useRef<HTMLInputElement>(null);
  const hintId = useId();
  return (
    <HostConfirmDialog
      title="この回を中止しますか？"
      description={`${when}の回を中止し、確定している ${bookings} 件の予約を取り消して、合計 ${yen(refundYen)} を全額返金します。この回は新しい予約を受け付けなくなります。この操作は元に戻せません。`}
      focusRef={first}
      hint={reason ? null : <p id={hintId} className="basis-full text-xs text-muted">中止の理由を選ぶと中止できます</p>}
      confirm={
        <button type="submit" disabled={!reason} aria-describedby={reason ? undefined : hintId} className={`${DANGER_BUTTON} ${DISABLED}`}>
          {bookings} 件を取り消して中止する
        </button>
      }
      onConfirm={() => {
        if (reason) onConfirm({ reason, note });
      }}
      onClose={onClose}
    >
      <p className="mt-3 text-[0.8125rem] text-ink-soft">予約者には取消と返金のお知らせがメールで届きます。確認待ちの支払いは NIHO サポートが対応します。</p>
      <CancelFields reasons={SITE_SESSION_CANCEL_REASONS} reason={reason} setReason={setReason} note={note} setNote={setNote} first={first} />
    </HostConfirmDialog>
  );
}
