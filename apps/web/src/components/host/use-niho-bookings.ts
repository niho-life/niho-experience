"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { HostLiveBookingListItem, HostLiveBookingListResponse } from "@/host/live-bookings";
import { hostFetch } from "@/lib/host/client-session";

/*
 * NIHO's booking list through the provider operations BFF (#87/#90), a page at a time: for 予約 and メッセージ
 * while NIHO's bookings are the screen (HostLiveBookings), and for 予約's one list beside this site's bookings
 * (HostBookings, #84). Nothing is read again on its own (no polling).
 */

export type NihoListState = "loading" | "ready" | "empty" | "error" | "revoked";

/** What the page says once NIHO answered 401 (the session) or 403/404 (the permission). */
export function nihoRevokedText(status: number): string {
  return status === 401
    ? "ログイン状態を確認できません。ページを再読み込みして、必要ならNIHOでログインし直してください。"
    : "この提供者の予約を見る権限がありません。提供者を切り替えるか、権限を確認してください。";
}

export const NIHO_LIST_FAILED_TEXT = "予約を読み込めませんでした。";

/**
 * The list, where its next page starts, and how reading it went. `load()` reads the first page again (replacing
 * the list), `load(cursor)` the next one; one read at a time, and a newer read wins. `revoke` ends the list after
 * NIHO said 401/403/404, from the list or from a booking's detail; `onRevoke` lets the page drop what it shows.
 * Not `enabled`: nothing is read and the list stays empty (a screen without NIHO's bookings).
 */
export function useNihoBookingList(providerId: string, { enabled = true, onRevoke }: { enabled?: boolean; onRevoke?: (status: number) => void } = {}) {
  const [items, setItems] = useState<HostLiveBookingListItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [state, setState] = useState<NihoListState>(enabled ? "loading" : "empty");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const version = useRef(0);
  const busyRef = useRef(false);
  const revoked = useRef(onRevoke);
  const root = `provider-operations/${encodeURIComponent(providerId)}/bookings`;

  useEffect(() => { revoked.current = onRevoke; }, [onRevoke]);

  const revoke = useCallback((status: number) => {
    ++version.current;
    busyRef.current = false; setBusy(false);
    setItems([]); setCursor(null); setState("revoked"); setError(nihoRevokedText(status));
    revoked.current?.(status);
  }, []);

  const load = useCallback(async (next?: string | null) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true);
    const current = ++version.current;
    if (!next) setState("loading");
    setError("");
    try {
      const response = await hostFetch(`${root}${next ? `?cursor=${encodeURIComponent(next)}` : ""}`);
      if (response.status === 401 || response.status === 403 || response.status === 404) { if (current === version.current) revoke(response.status); return; }
      if (!response.ok) throw new Error(NIHO_LIST_FAILED_TEXT);
      const value = await response.json() as HostLiveBookingListResponse;
      if (current !== version.current) return;
      setItems((known) => next ? [...new Map([...known, ...value.bookings].map((item) => [item.id, item])).values()] : value.bookings);
      setCursor(value.nextCursor);
      setState(value.bookings.length === 0 && !next ? "empty" : "ready");
    } catch {
      if (current !== version.current) return;
      setState("error"); setError(NIHO_LIST_FAILED_TEXT);
    } finally {
      if (current === version.current) { busyRef.current = false; setBusy(false); }
    }
  }, [revoke, root]);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    queueMicrotask(() => { if (active) void load(); });
    return () => { active = false; };
  }, [enabled, load]);

  return { items, cursor, state, busy, error, load, revoke };
}
