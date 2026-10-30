"use client";

import { useEffect, useRef, useState } from "react";
import { StatusPill } from "./ui";
import { HostIcon } from "./HostIcon";

type ChannelLabel = "SYNCED" | "PENDING" | "CHECKING" | "ERROR" | "UNVERIFIED" | "HELD";

interface ChannelStatus {
  readonly occurrenceId: string;
  readonly site: string;
  readonly desired: "OPEN" | "CLOSED";
  readonly label: ChannelLabel;
}

export type HostChannelState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly channels: readonly ChannelStatus[] }
  | { readonly kind: "error" }
  | { readonly kind: "disabled" };

function decodeChannels(value: unknown): readonly ChannelStatus[] | null {
  if (!value || typeof value !== "object" || !("channels" in value) || !Array.isArray(value.channels)) return null;
  const decoded: ChannelStatus[] = [];
  for (const entry of value.channels) {
    if (!entry || typeof entry !== "object") return null;
    const item = entry as Record<string, unknown>;
    if (typeof item.occurrenceId !== "string" || typeof item.site !== "string" || item.site.length === 0 || item.site.length > 120
      || (item.desired !== "OPEN" && item.desired !== "CLOSED")
      || (item.label !== "SYNCED" && item.label !== "PENDING" && item.label !== "CHECKING" && item.label !== "ERROR" && item.label !== "UNVERIFIED" && item.label !== "HELD")) return null;
    decoded.push({ occurrenceId: item.occurrenceId, site: item.site, desired: item.desired, label: item.label });
  }
  return decoded;
}

/** Polls only while this tab is visible. Each response belongs to one provider and one sequence. */
export function useHostChannelStatuses(providerId: string, refreshVersion: string): HostChannelState {
  const [state, setState] = useState<HostChannelState>({ kind: "loading" });
  const sequence = useRef(0);
  useEffect(() => {
    let active = true;
    let disabled = false;
    let initial = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;
    const clear = () => { if (timer) clearTimeout(timer); timer = null; controller?.abort(); controller = null; };
    const poll = async () => {
      if (!active || disabled || document.visibilityState !== "visible") return;
      const current = ++sequence.current;
      const requestController = new AbortController();
      controller = requestController;
      if (initial) setState({ kind: "loading" });
      try {
        const url = new URL("/host/calendar/channels", location.origin);
        url.searchParams.set("providerId", providerId);
        const response = await fetch(url, { credentials: "same-origin", cache: "no-store", signal: requestController.signal });
        if (!active || requestController.signal.aborted || current !== sequence.current) return;
        if (response.status === 404) {
          disabled = true;
          if (active && current === sequence.current) setState({ kind: "disabled" });
          return;
        }
        if (!response.ok) throw new Error("channel_read_failed");
        const channels = decodeChannels(await response.json());
        if (channels === null) throw new Error("channel_shape_failed");
        if (active && !requestController.signal.aborted && current === sequence.current) setState({ kind: "ready", channels });
      } catch {
        if (requestController.signal.aborted || !active || current !== sequence.current) return;
        setState({ kind: "error" });
      } finally {
        // An aborted visibility/provider request must not clear the replacement request or add a second timer.
        if (active && current === sequence.current) {
          initial = false;
          controller = null;
          if (!disabled && document.visibilityState === "visible") timer = setTimeout(() => void poll(), 20_000);
        }
      }
    };
    const visibility = () => {
      clear();
      sequence.current += 1;
      if (document.visibilityState === "visible") void poll();
    };
    document.addEventListener("visibilitychange", visibility);
    if (document.visibilityState === "visible") void poll();
    return () => { active = false; sequence.current += 1; document.removeEventListener("visibilitychange", visibility); clear(); };
  }, [providerId, refreshVersion]);
  return state;
}

function statusView(label: ChannelLabel): { label: string; tone: "ok" | "wait" | "draft" } {
  if (label === "SYNCED") return { label: "反映済み", tone: "ok" };
  if (label === "PENDING") return { label: "反映待ち", tone: "wait" };
  if (label === "CHECKING") return { label: "確認中", tone: "wait" };
  if (label === "UNVERIFIED") return { label: "未確認", tone: "draft" };
  // New OPEN waits until the Studio re-reads reservations after a stop. It is not reflected success.
  if (label === "HELD") return { label: "保留中", tone: "wait" };
  return { label: "要確認", tone: "wait" };
}

export function channelSummary(state: HostChannelState, occurrenceId?: string): { label: string; tone: "ok" | "wait" | "draft" } | null {
  if (state.kind === "disabled") return null;
  if (state.kind === "loading") return { label: "確認中", tone: "draft" };
  if (state.kind === "error") return { label: "要確認", tone: "wait" };
  const channels = occurrenceId ? state.channels.filter((item) => item.occurrenceId === occurrenceId) : state.channels;
  if (channels.length === 0) return { label: "未確認", tone: "draft" };
  if (channels.some((item) => item.label === "ERROR")) return statusView("ERROR");
  if (channels.some((item) => item.label === "UNVERIFIED")) return statusView("UNVERIFIED");
  if (channels.some((item) => item.label === "HELD")) return statusView("HELD");
  if (channels.some((item) => item.label === "CHECKING")) return statusView("CHECKING");
  if (channels.some((item) => item.label === "PENDING")) return statusView("PENDING");
  return statusView("SYNCED");
}

export function HostCalendarChannelDetails({ state, occurrenceId }: { state: HostChannelState; occurrenceId: string }) {
  const summary = channelSummary(state, occurrenceId);
  if (!summary) return null;
  const channels = state.kind === "ready" ? state.channels.filter((item) => item.occurrenceId === occurrenceId) : [];
  return <details className="group border-y border-line">
    <summary className="flex min-h-14 cursor-pointer items-center justify-between gap-3 py-2 font-extrabold"><span>掲載先</span><span className="flex items-center gap-2"><StatusPill status={summary} /><HostIcon name="chevronDown" className="size-4 text-muted group-open:rotate-180" /></span></summary>
    <div className="pb-3">
      {state.kind === "error" ? <p role="alert" className="text-sm font-bold text-warn">掲載先を確認できません</p> : null}
      {state.kind === "loading" ? <p role="status" className="text-sm text-ink-soft">確認中…</p> : null}
      {channels.length ? <ul className="divide-y divide-line">{channels.map((channel, index) => <li key={`${channel.site}:${index}`} className="flex min-h-12 items-center justify-between gap-3 py-2"><strong className="min-w-0 truncate text-sm">{channel.site}</strong><StatusPill status={statusView(channel.label)} /></li>)}</ul> : null}
    </div>
  </details>;
}
