"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { consoleButtonClass } from "./host-ui";

export type HostLeaveMode = "dirty" | "saving" | "unknown" | null;
type LeaveDestination =
  | { kind: "link"; anchor: HTMLAnchorElement }
  | { kind: "form"; form: HTMLFormElement; submitter: HTMLElement | null }
  | { kind: "history"; delta: number };

export interface HostLeaveGuard {
  asking: boolean;
  requestKey: number;
  stay: () => void;
  leave: () => void;
}

interface HostHistoryGuardState {
  readonly dirty: boolean;
  readonly leaving: boolean;
  readonly current: { href: string; state: unknown; index: number | null };
  onHistoryLeave: (delta: number) => void;
}

declare global {
  interface Window {
    __nihoHostHistoryGuard?: HostHistoryGuardState;
  }
}

function currentNavigationIndex(): number | null {
  const navigation = (window as Window & { navigation?: { currentEntry?: { index: number } | null } }).navigation;
  const index = navigation?.currentEntry?.index;
  return typeof index === "number" && index >= 0 ? index : null;
}

export function isHostNavigationForm(form: Pick<HTMLFormElement, "hasAttribute">): boolean {
  return form.hasAttribute("data-niho-navigation-form");
}

/** One shared global guard contract for links, forms, history and beforeunload. */
export function useHostLeaveGuard(mode: HostLeaveMode): HostLeaveGuard {
  const [destination, setDestination] = useState<LeaveDestination | null>(null);
  const [requestKey, setRequestKey] = useState(0);
  const modeRef = useRef(mode);
  const leaving = useRef(false);
  const historyEntry = useRef<{ href: string; state: unknown; index: number | null }>({ href: "", state: null, index: null });

  useLayoutEffect(() => {
    modeRef.current = mode;
    historyEntry.current = { href: window.location.href, state: window.history.state, index: currentNavigationIndex() };
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (modeRef.current === null || leaving.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    const onClick = (event: MouseEvent) => {
      if (modeRef.current === null || leaving.current || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(anchor instanceof HTMLAnchorElement) || (anchor.target && anchor.target !== "_self") || anchor.hasAttribute("download")) return;
      const to = new URL(anchor.href, window.location.href);
      if (to.pathname === window.location.pathname && to.search === window.location.search) return;
      event.preventDefault();
      event.stopPropagation();
      setDestination({ kind: "link", anchor });
      setRequestKey((value) => value + 1);
    };
    const onSubmit = (event: SubmitEvent) => {
      if (modeRef.current === null || leaving.current || event.defaultPrevented || !(event.target instanceof HTMLFormElement)) return;
      // Navigation forms opt in. Local save/confirmation forms must reach their React handlers.
      if (!isHostNavigationForm(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      setDestination({ kind: "form", form: event.target, submitter: event.submitter });
      setRequestKey((value) => value + 1);
    };
    const historyGuard: HostHistoryGuardState = {
      get dirty() { return modeRef.current !== null; },
      get leaving() { return leaving.current; },
      get current() { return historyEntry.current; },
      onHistoryLeave: (delta) => {
        setDestination({ kind: "history", delta });
        setRequestKey((value) => value + 1);
      },
    };
    window.__nihoHostHistoryGuard = historyGuard;
    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener("click", onClick, true);
    window.addEventListener("submit", onSubmit, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener("click", onClick, true);
      window.removeEventListener("submit", onSubmit, true);
      if (window.__nihoHostHistoryGuard === historyGuard) delete window.__nihoHostHistoryGuard;
    };
  }, [mode]);

  return {
    asking: destination !== null,
    requestKey,
    stay: () => setDestination(null),
    leave: () => {
      if (!destination || modeRef.current === "saving") return;
      leaving.current = true;
      setDestination(null);
      if (destination.kind === "link") {
        if (destination.anchor.isConnected) destination.anchor.click();
        else window.location.assign(destination.anchor.href);
      } else if (destination.kind === "form") {
        destination.form.requestSubmit(destination.submitter instanceof HTMLButtonElement || destination.submitter instanceof HTMLInputElement ? destination.submitter : undefined);
      } else {
        window.history.go(destination.delta);
      }
    },
  };
}

const LEAVE_BUTTON = "inline-flex h-[38px] shrink-0 items-center justify-center rounded-full border border-line-strong bg-canvas px-4 text-[0.84375rem] leading-none font-extrabold whitespace-nowrap text-danger hover:bg-danger-pale";

export function HostLeaveDialog({ mode = "dirty", requestKey = 0, onStay, onLeave, onDiscard }: { mode?: Exclude<HostLeaveMode, null>; requestKey?: number; onStay: () => void; onLeave: () => void; onDiscard?: () => void }) {
  const baseId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const stay = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const element = dialog.current;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled && element?.isConnected && !element.open) {
        element.showModal();
        stay.current?.focus();
      }
    });
    return () => {
      cancelled = true;
      if (previousFocus?.isConnected && (document.activeElement === document.body || element?.contains(document.activeElement))) previousFocus.focus();
    };
  }, [requestKey]);
  const saving = mode === "saving";
  const title = saving ? "保存の通信中です" : mode === "unknown" ? "保存結果を確認できていません" : "保存していない変更があります";
  const body = saving
    ? "結果が戻るまでこの画面でお待ちください。通信中は別の画面へ移動できません。"
    : mode === "unknown"
      ? "移動すると再確認と同じ内容の再送ができなくなります。受付済みの処理があっても取り消されません。"
      : "保存せずに移動すると、この画面での変更は失われます。";
  return (
    <dialog ref={dialog} aria-labelledby={`${baseId}-title`} aria-describedby={`${baseId}-body`} onCancel={(event) => { event.preventDefault(); if (!saving) onStay(); }} onClose={onStay} className="m-auto w-[calc(100%-2rem)] max-w-[420px] rounded-2xl border-0 bg-canvas p-0 text-[0.875rem] leading-[1.6] text-ink shadow-[0_20px_60px_rgb(0_0_0/0.2)] backdrop:bg-ink/40">
      <div className="px-4 pt-4 pb-3 md:px-5 md:pt-5">
        <h2 id={`${baseId}-title`} className="font-sans text-[0.9375rem] leading-normal font-extrabold tracking-normal">{title}</h2>
        <p id={`${baseId}-body`} className="mt-1 text-ink-soft">{body}</p>
      </div>
      <div className="flex flex-wrap justify-end gap-2 border-t border-line px-4 py-3 md:px-5">
        {!saving ? <button type="button" onClick={() => { onDiscard?.(); onLeave(); }} className={LEAVE_BUTTON}>{mode === "unknown" ? "確認を破棄して移動" : "保存せずに移動"}</button> : null}
        <button ref={stay} type="button" onClick={onStay} className={consoleButtonClass("primary")}>{saving ? "この画面で待つ" : mode === "unknown" ? "確認を続ける" : "編集を続ける"}</button>
      </div>
    </dialog>
  );
}
