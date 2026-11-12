"use client";

import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { HOST_DIALOG } from "@/components/host/HostConfirmDialog";

/** A modal <dialog> on the page, the same way HostConfirmDialog opens one, for the invitation's two faces. */
export function ModalDialog({ titleId, focusRef, locked = false, onClose, children }: { titleId: string; focusRef: RefObject<HTMLElement | null>; locked?: boolean; onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    let cancelled = false;
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
    <dialog ref={dialog} aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); if (!locked) onClose(); }} className={HOST_DIALOG}>
      {children}
    </dialog>
  );
}

export const DIALOG_BODY = "min-h-0 flex-1 overflow-y-auto px-4 pt-4 pb-4 md:px-5 md:pt-5";
export const DIALOG_FOOT = "flex flex-wrap items-center justify-end gap-2 border-t border-line px-4 py-3 md:px-5";
export const DIALOG_TITLE = "font-sans text-[0.9375rem] leading-normal font-extrabold tracking-normal";

