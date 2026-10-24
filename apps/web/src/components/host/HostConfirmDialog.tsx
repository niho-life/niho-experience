"use client";

import { useEffect, useId, useRef, type ReactNode, type RefObject } from "react";
import { consoleButtonClass } from "./host-ui";

/*
 * A confirmation in a modal <dialog> on the page (the offer dialog's make), never the browser's
 * confirm(). Nothing happens until its own button is pressed; Esc and やめる hand cancellation
 * to the parent synchronously. The parent unmounts it without a stale native close callback.
 */

export const HOST_DIALOG =
  "m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-[460px] overflow-hidden rounded-2xl border-0 bg-canvas p-0 text-[0.875rem] leading-[1.6] text-ink shadow-[0_20px_60px_rgb(0_0_0/0.2)] backdrop:bg-ink/40";

export interface HostConfirmDialogProps {
  title: string;
  description: string;
  /** What gets focus when it opens: the safe choice, or the first field. */
  focusRef: RefObject<HTMLElement | null>;
  stayRef?: RefObject<HTMLButtonElement | null>;
  /** The confirming button (type="submit"). */
  confirm: ReactNode;
  /** Said next to the buttons while the confirming one waits for something. */
  hint?: ReactNode;
  onConfirm: () => void;
  onClose: () => void;
  children?: ReactNode;
}

export function HostConfirmDialog({ title, description, focusRef, stayRef, confirm, hint, onConfirm, onClose, children }: HostConfirmDialogProps) {
  const baseId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    let cancelled = false;
    // A queued open avoids the StrictMode mount/unmount pass racing showModal/close.
    queueMicrotask(() => {
      if (!cancelled && element?.isConnected && !element.open) {
        element.showModal();
        focusRef.current?.focus();
      }
    });
    return () => {
      cancelled = true;
      if (previousFocus?.isConnected && (document.activeElement === document.body || element?.contains(document.activeElement))) previousFocus.focus();
    };
  }, [focusRef]);
  return (
    <dialog ref={dialog} aria-labelledby={`${baseId}-title`} aria-describedby={`${baseId}-body`} onCancel={(event) => { event.preventDefault(); onClose(); }} onClose={onClose} className={HOST_DIALOG}>
      <form
        className="flex max-h-[calc(100dvh-2rem)] flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          if (!event.currentTarget.reportValidity()) return;
          // Close parent state synchronously for every caller. A queued native close
          // event could clear a newly opened confirmation or its immutable command.
          onConfirm();
          onClose();
        }}
      >
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-4 pb-4 md:px-5 md:pt-5">
          <h2 id={`${baseId}-title`} className="font-sans text-[0.9375rem] leading-normal font-extrabold tracking-normal">
            {title}
          </h2>
          <p id={`${baseId}-body`} className="mt-1 text-ink-soft">
            {description}
          </p>
          {children}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-4 py-3 md:px-5">
          {hint}
          <button ref={stayRef} type="button" onClick={onClose} className={consoleButtonClass("secondary")}>
            やめる
          </button>
          {confirm}
        </div>
      </form>
    </dialog>
  );
}
