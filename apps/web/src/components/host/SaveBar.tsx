"use client";

import { HostIcon } from "./HostIcon";

/** 保存, only while something changed: a leaf pill floating at the bottom right on PC, a full-width band at the bottom on phones. `disabled`: not now (the NIHO-connected editor's reconcile, a save of unknown result). Shared by both editors. */
export function SaveBar({ dirty, saving, saved, onSave, disabled = false }: { dirty: boolean; saving: boolean; saved: boolean; onSave: () => void; disabled?: boolean }) {
  const button = dirty || saving;
  const shown = button || saved;
  return (
    <div
      className={`sticky bottom-0 z-20 mt-4 md:pointer-events-none md:bottom-4 md:flex md:items-center md:justify-end md:gap-3 ${
        shown ? "-mx-4 -mb-6 border-t border-line bg-canvas/95 px-4 pt-2.5 pb-[max(0.875rem,env(safe-area-inset-bottom))] backdrop-blur-sm md:mx-0 md:mb-0 md:border-0 md:bg-transparent md:p-0 md:backdrop-blur-none" : ""
      }`}
    >
      <p role="status" className="text-center text-[0.78125rem] font-extrabold text-moss md:text-right">
        {saved ? (
          <span className={`inline-flex items-center gap-1 md:rounded-full md:bg-canvas md:px-3 md:py-1.5 md:shadow-[0_4px_16px_rgb(0_0_0/0.1)] ${button ? "pb-2 md:pb-1.5" : ""}`}>
            <HostIcon name="check" className="size-3.5" />
            保存しました
          </span>
        ) : null}
      </p>
      {button ? (
        <button
          type="button"
          onClick={onSave}
          disabled={saving || disabled}
          className="block h-12 w-full rounded-xl bg-leaf text-[0.9375rem] font-extrabold text-ink hover:bg-leaf-hover disabled:opacity-60 md:pointer-events-auto md:h-11 md:w-auto md:rounded-full md:px-6 md:shadow-[0_8px_24px_rgb(0_0_0/0.14)]"
        >
          {saving ? "保存中…" : "保存"}
        </button>
      ) : null}
    </div>
  );
}
