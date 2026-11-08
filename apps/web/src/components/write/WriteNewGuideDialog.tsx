"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from "react";
import { useRouter } from "next/navigation";
import type { WriteProviderChoice } from "@/lib/write/client-types";
import { NewGuideForm } from "./NewGuideForm";

export interface WriteNewGuideDialogHandle {
  open(opener?: HTMLElement): void;
}

export const WriteNewGuideDialog = forwardRef<WriteNewGuideDialogHandle, {
  readonly providers: readonly WriteProviderChoice[];
  readonly experience: string | null;
  readonly autoOpen?: boolean;
  readonly returnPath?: string;
  readonly editPath?: string;
  readonly showTrigger?: boolean;
}>(function WriteNewGuideDialog({ providers, experience, autoOpen = false, returnPath = "/write", editPath = "/write", showTrigger = true }, ref) {
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const router = useRouter();
  const open = useCallback((nextOpener?: HTMLElement) => {
    opener.current = nextOpener ?? trigger.current ?? document.activeElement as HTMLElement | null;
    if (!dialog.current?.open) dialog.current?.showModal();
  }, []);
  const close = () => dialog.current?.close();
  useImperativeHandle(ref, () => ({ open }), [open]);
  useEffect(() => { if (autoOpen && !dialog.current?.open) open(); }, [autoOpen, open]);
  return (
    <>
      {showTrigger ? <button ref={trigger} type="button" className="write-primary" onClick={(event) => open(event.currentTarget)}>＋ 新しい記事</button> : null}
      <dialog
        ref={dialog}
        className="write-new-dialog"
        aria-labelledby="write-new-dialog-title"
        onClose={() => {
          if (autoOpen) router.replace(returnPath);
          else opener.current?.focus();
        }}
        onClick={(event) => { if (event.target === dialog.current) close(); }}
      >
        <div className="write-new-dialog-card">
          <header><div><h2 id="write-new-dialog-title">新しい記事</h2><p>題名だけで下書きを始められます。作成するまで記事は保存されません。</p></div><button type="button" className="write-dialog-close" onClick={close} aria-label="新しい記事を閉じる">×</button></header>
          <NewGuideForm providers={providers} experience={experience} editPath={editPath} />
        </div>
      </dialog>
    </>
  );
});
