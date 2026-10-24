"use client";

import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { usePathname, useSearchParams } from "next/navigation";

type Destination =
  | { kind: "link"; anchor: HTMLAnchorElement }
  | { kind: "form"; form: HTMLFormElement; submitter: HTMLElement | null }
  | { kind: "history"; delta: number }
  | { kind: "callback"; run: () => void };

interface AdminHistoryGuardState {
  readonly blocking: boolean;
  readonly leaving: boolean;
  readonly current: { href: string; state: unknown; index: number | null };
  onHistoryLeave: (delta: number) => void;
}

declare global {
  interface Window {
    __nihoAdminHistoryGuard?: AdminHistoryGuardState;
    __nihoAdminHistoryGuardInstalled?: boolean;
    navigation?: { currentEntry?: { index: number } | null };
  }
}

interface GuardContextValue {
  setProtection: (key: string, dirty: boolean, saving: boolean) => void;
  removeProtection: (key: string) => void;
  navigate: (run: () => void) => void;
  reset: () => void;
}

const GuardContext = createContext<GuardContextValue | null>(null);

export interface AdminLeaveProtectionState { dirty: boolean; saving: boolean }

/** Keyed so case editing and an immutable operation can protect the same page independently. */
export class AdminLeaveProtectionRegistry {
  readonly #entries = new Map<string, AdminLeaveProtectionState>();
  set(key: string, value: AdminLeaveProtectionState) { this.#entries.set(key, value); return this.current(); }
  delete(key: string) { this.#entries.delete(key); return this.current(); }
  reset() { this.#entries.clear(); return this.current(); }
  current(): AdminLeaveProtectionState {
    let dirty = false; let saving = false;
    for (const value of this.#entries.values()) { dirty ||= value.dirty; saving ||= value.saving; }
    return { dirty, saving };
  }
}

function currentNavigationIndex(): number | null {
  const index = window.navigation?.currentEntry?.index;
  return typeof index === "number" && index >= 0 ? index : null;
}

function LeaveDialog({ saving, onStay, onLeave }: { saving: boolean; onStay: () => void; onLeave: () => void }) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const stay = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
    stay.current?.focus();
  }, []);
  return <dialog
    ref={dialog}
    aria-labelledby={`${id}-title`}
    aria-describedby={`${id}-body`}
    onCancel={(event) => { event.preventDefault(); if (!saving) { dialog.current?.close(); onStay(); } }}
    onClose={onStay}
    className="m-auto w-[calc(100%-2rem)] max-w-[420px] rounded-2xl border-0 bg-canvas p-0 text-[0.875rem] leading-[1.6] text-ink shadow-[0_20px_60px_rgb(0_0_0/0.2)] backdrop:bg-ink/40"
  >
    <div className="px-4 pt-4 pb-3 md:px-5 md:pt-5">
      <h2 id={`${id}-title`} className="font-sans text-[0.9375rem] font-extrabold">{saving ? "保存結果を確認しています" : "保存していない変更があります"}</h2>
      <p id={`${id}-body`} className="mt-1 text-ink-soft">{saving ? "通信が終わるまで、この予約から移動できません。" : "移動すると、担当・内部メモまたは入力中の予約対応・連絡内容がこの画面から失われます。受付済みの処理は取り消されず、同じ受付番号や履歴から後で確認できます。"}</p>
    </div>
    <div className="flex flex-wrap justify-end gap-2 border-t border-line px-4 py-3 md:px-5">
      <button type="button" onClick={() => { dialog.current?.close(); onLeave(); }} disabled={saving} className="inline-flex min-h-10 items-center rounded-full border border-line-strong px-4 font-extrabold text-danger hover:bg-danger-pale disabled:cursor-not-allowed disabled:opacity-45">破棄して移動</button>
      <button ref={stay} type="button" onClick={() => { dialog.current?.close(); onStay(); }} className="inline-flex min-h-10 items-center rounded-full bg-leaf px-4 font-extrabold hover:bg-leaf-hover">編集を続ける</button>
    </div>
  </dialog>;
}

export function AdminLeaveGuardProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const routeIdentity = `${pathname}?${searchParams.toString()}`;
  const [protection, setProtectionState] = useState({ dirty: false, saving: false });
  const protections = useRef(new AdminLeaveProtectionRegistry());
  const [destination, setDestination] = useState<Destination | null>(null);
  const protectionRef = useRef(protection);
  const leaving = useRef(false);
  const focusReturn = useRef<HTMLElement | null>(null);
  const historyEntry = useRef<{ href: string; state: unknown; index: number | null }>({ href: "", state: null, index: null });
  const previousRouteIdentity = useRef(routeIdentity);
  const bypassTimer = useRef<number | null>(null);
  const blocking = protection.dirty || protection.saving;

  useEffect(() => {
    if (previousRouteIdentity.current === routeIdentity) return;
    previousRouteIdentity.current = routeIdentity;
    leaving.current = false;
    if (bypassTimer.current !== null) window.clearTimeout(bypassTimer.current);
    bypassTimer.current = null;
    historyEntry.current = { href: window.location.href, state: window.history.state, index: currentNavigationIndex() };
  }, [routeIdentity]);

  useEffect(() => () => {
    if (bypassTimer.current !== null) window.clearTimeout(bypassTimer.current);
  }, []);

  const setProtection = useCallback((key: string, dirty: boolean, saving: boolean) => {
    const next = protections.current.set(key, { dirty, saving });
    protectionRef.current = next;
    setProtectionState(next);
  }, []);
  const removeProtection = useCallback((key: string) => {
    const next = protections.current.delete(key);
    protectionRef.current = next;
    setProtectionState(next);
  }, []);

  const ask = useCallback((next: Destination) => {
    if (!protectionRef.current.dirty && !protectionRef.current.saving) {
      if (next.kind === "callback") next.run();
      else if (next.kind === "link") next.anchor.click();
      else if (next.kind === "form") next.form.requestSubmit(next.submitter instanceof HTMLButtonElement || next.submitter instanceof HTMLInputElement ? next.submitter : undefined);
      else window.history.go(next.delta);
      return;
    }
    focusReturn.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setDestination(next);
  }, []);

  useLayoutEffect(() => {
    historyEntry.current = { href: window.location.href, state: window.history.state, index: currentNavigationIndex() };
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if ((!protectionRef.current.dirty && !protectionRef.current.saving) || leaving.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    const onClick = (event: MouseEvent) => {
      if ((!protectionRef.current.dirty && !protectionRef.current.saving) || leaving.current || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(anchor instanceof HTMLAnchorElement) || (anchor.target && anchor.target !== "_self") || anchor.hasAttribute("download")) return;
      const to = new URL(anchor.href, window.location.href);
      if (to.pathname === window.location.pathname && to.search === window.location.search) return;
      event.preventDefault();
      event.stopPropagation();
      ask({ kind: "link", anchor });
    };
    const onSubmit = (event: SubmitEvent) => {
      if ((!protectionRef.current.dirty && !protectionRef.current.saving) || leaving.current || event.defaultPrevented || !(event.target instanceof HTMLFormElement)) return;
      event.preventDefault();
      event.stopPropagation();
      ask({ kind: "form", form: event.target, submitter: event.submitter });
    };
    const guard: AdminHistoryGuardState = {
      get blocking() { return protectionRef.current.dirty || protectionRef.current.saving; },
      get leaving() { return leaving.current; },
      get current() { return historyEntry.current; },
      onHistoryLeave: (delta) => ask({ kind: "history", delta }),
    };
    window.__nihoAdminHistoryGuard = guard;
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClick, true);
    document.addEventListener("submit", onSubmit, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("submit", onSubmit, true);
      if (window.__nihoAdminHistoryGuard === guard) delete window.__nihoAdminHistoryGuard;
    };
  }, [ask, blocking]);

  const stay = () => {
    setDestination(null);
    requestAnimationFrame(() => focusReturn.current?.focus());
  };
  const leave = useCallback(() => {
    if (!destination || protectionRef.current.saving) return;
    leaving.current = true;
    const sourceHref = window.location.href;
    setDestination(null);
    if (destination.kind === "callback") destination.run();
    else if (destination.kind === "link") {
      if (destination.anchor.isConnected) destination.anchor.click();
      else window.location.assign(destination.anchor.href);
    }
    else if (destination.kind === "form") destination.form.requestSubmit(destination.submitter instanceof HTMLButtonElement || destination.submitter instanceof HTMLInputElement ? destination.submitter : undefined);
    else window.history.go(destination.delta);
    if (bypassTimer.current !== null) window.clearTimeout(bypassTimer.current);
    bypassTimer.current = window.setTimeout(() => {
      bypassTimer.current = null;
      if (window.location.href === sourceHref) leaving.current = false;
    }, 1500);
  }, [destination]);
  useEffect(() => {
    if (!destination || blocking || leaving.current) return;
    const timer = window.setTimeout(leave, 0);
    return () => window.clearTimeout(timer);
  }, [blocking, destination, leave]);
  const reset = useCallback(() => {
    leaving.current = false;
    if (bypassTimer.current !== null) window.clearTimeout(bypassTimer.current);
    bypassTimer.current = null;
    const next = protections.current.reset();
    protectionRef.current = next;
    setProtectionState(next);
    setDestination(null);
  }, []);
  const context = useMemo<GuardContextValue>(() => ({ setProtection, removeProtection, navigate: (run) => ask({ kind: "callback", run }), reset }), [ask, removeProtection, reset, setProtection]);

  return <GuardContext.Provider value={context}>
    {children}
    {destination ? <LeaveDialog saving={protection.saving} onStay={stay} onLeave={leave} /> : null}
  </GuardContext.Provider>;
}

export function useAdminLeaveProtection(dirty: boolean, saving: boolean) {
  const guard = useContext(GuardContext);
  const key = useId();
  useLayoutEffect(() => {
    guard?.setProtection(key, dirty, saving);
    return () => guard?.removeProtection(key);
  }, [dirty, guard, key, saving]);
}

export function useAdminGuardedNavigation() {
  const guard = useContext(GuardContext);
  return guard?.navigate ?? ((run: () => void) => run());
}

export function useAdminLeaveGuardReset() {
  return useContext(GuardContext)?.reset ?? (() => undefined);
}
