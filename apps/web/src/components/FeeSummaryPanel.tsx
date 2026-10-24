"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { type ExperienceFeeSummaryAccounting, type ExperienceFeeSummaryStatus } from "@niho-experience/api-client/fee-summary";
import { adminDateTime } from "@/admin/date-time";
import { yen } from "@/host/format";
import { hostFetch } from "@/lib/host/client-session";
import {
  feeSummaryPanelInstanceKey,
  feeSummaryTarget,
  feeSummaryViewFromResult,
  initialFeeSummaryView,
  loadFeeSummaryRequest,
  type FeeSummaryAudience,
  type FeeSummaryLoadState,
} from "./fee-summary-panel-state";

type FeeSummaryPanelProps = { audience: FeeSummaryAudience; bookingId: string; actorKey: string; enabled: boolean; onSessionExpired?: () => void };

const STATUS: Record<ExperienceFeeSummaryStatus, { label: string; detail: string; tone: string }> = {
  LEGACY_NOT_RECORDED: { label: "料金記録なし", detail: "料金の記録がなく、受付条件や精算額を画面から確定できません。", tone: "bg-sand text-ink-soft" },
  PREPARING: { label: "精算準備中", detail: "受付時の料金と返金記録を確認しています。", tone: "bg-sand text-ink-soft" },
  PROCESSING_COST_PENDING: { label: "決済費用を確認中", detail: "決済費用の確定を待っています。顧客への返金状態とは別の確認です。", tone: "bg-warn-pale text-warn" },
  PROCESSING: { label: "返金・精算処理中", detail: "顧客への返金とホスト側の費用精算を別々に確認しています。", tone: "bg-warn-pale text-warn" },
  RESULT_UNKNOWN: { label: "処理結果を確認中", detail: "外部処理の結果を確定できていません。支払済み・入金済みとは扱いません。", tone: "bg-warn-pale text-warn" },
  REVIEW_REQUIRED: { label: "要確認", detail: "NIHO事務局による記録の確認が必要です。", tone: "bg-danger-pale text-danger" },
  SETTLED: { label: "精算確認済み", detail: "この予約の料金記録上、費用精算を確認済みです。顧客への返金全般や口座への入金完了を示す表示ではありません。", tone: "bg-leaf-pale text-moss" },
};

function amount(value: number | null) { return value === null ? "未確認" : yen(value); }

function AmountRows({ accounting, audience }: { accounting: ExperienceFeeSummaryAccounting; audience: FeeSummaryAudience }) {
  const rows = [
    ["顧客への返金（完了）", accounting.successfulRefundedYen],
    ["顧客への返金（処理中）", accounting.pendingRefundedYen],
    ["残存売上に対応するNIHO利用料", accounting.targetTotalFeeYen],
    ["NIHO利用料の返還（完了）", accounting.applicationFeeRefundedYen],
    ["NIHO利用料の累計返還目標", accounting.targetApplicationFeeRefundYen],
    ["決済費用の補填（完了）", accounting.processingCompensatedYen],
    ["決済費用の累計補填目標", accounting.targetProcessingCompensationYen],
    ["ホスト残額", accounting.hostRetainedAfterCreditsYen],
  ] as const;
  return <dl className="mt-3 grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-2 text-[0.8125rem]">
    {rows.map(([label, value]) => <div key={label} className="contents"><dt className="min-w-0 text-ink-soft">{label}</dt><dd className="text-right font-extrabold tabular-nums">{amount(value)}</dd></div>)}
    {audience === "admin" ? <><dt className="min-w-0 border-t border-line pt-2 text-ink-soft">NIHO入出金差額</dt><dd className="border-t border-line pt-2 text-right font-extrabold tabular-nums">{amount(accounting.netNihoCashYen)}</dd><dt className="col-span-2 text-xs text-muted">収益や利益を表す項目ではありません。</dt></> : null}
  </dl>;
}

async function requestSummary(audience: FeeSummaryAudience, bookingId: string, signal: AbortSignal) {
  const path = `bookings/${encodeURIComponent(bookingId)}/fee-summary`;
  return audience === "host"
    ? hostFetch(path, { signal })
    : fetch(`/admin/api/${path}`, { credentials: "same-origin", cache: "no-store", signal });
}

export function FeeSummaryPanel(props: FeeSummaryPanelProps) {
  const { audience, bookingId, actorKey, enabled } = props;
  return <FeeSummaryPanelView key={feeSummaryPanelInstanceKey(audience, actorKey, bookingId, enabled)} {...props} />;
}

function FeeSummaryPanelView({ audience, bookingId, actorKey, enabled, onSessionExpired }: FeeSummaryPanelProps) {
  const headingId = useId();
  const currentTarget = feeSummaryTarget(audience, actorKey, bookingId);
  const [view, setView] = useState(() => initialFeeSummaryView(currentTarget, enabled));
  const [refresh, setRefresh] = useState(0);
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const state: FeeSummaryLoadState = !enabled ? "disabled" : view.target === currentTarget ? view.value : "loading";
  const current = state === "ready" && view.target === currentTarget ? view.summary : null;

  const load = useCallback(async (expectedGeneration: number, expectedTarget: string, signal: AbortSignal) => {
    const isCurrent = () => !signal.aborted && generation.current === expectedGeneration && expectedTarget === currentTarget;
    const result = await loadFeeSummaryRequest({ bookingId, request: () => requestSummary(audience, bookingId, signal), isCurrent });
    if (!result || !isCurrent()) return;
    setView(feeSummaryViewFromResult(expectedTarget, result));
    if (result.value === "expired") {
      ++generation.current;
      controller.current?.abort();
      onSessionExpired?.();
    }
  }, [audience, bookingId, currentTarget, onSessionExpired]);

  useEffect(() => {
    const expectedGeneration = ++generation.current;
    controller.current?.abort();
    if (!enabled) { controller.current = null; return; }
    const next = new AbortController(); controller.current = next;
    void Promise.resolve().then(() => {
      if (next.signal.aborted || generation.current !== expectedGeneration) return;
      setView(initialFeeSummaryView(currentTarget, true));
      return load(expectedGeneration, currentTarget, next.signal);
    });
    return () => { next.abort(); };
  }, [currentTarget, enabled, load, refresh]);

  const retry = () => {
    if (state === "loading") return;
    ++generation.current;
    controller.current?.abort();
    setView(initialFeeSummaryView(currentTarget, true));
    setRefresh((value) => value + 1);
  };
  const status = current ? STATUS[current.status] : null;
  return <section aria-labelledby={headingId} aria-busy={state === "loading"} className="mt-4 border-t border-line pt-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 id={headingId} className="font-sans text-xs font-extrabold tracking-[0.04em] text-ink-soft">料金・精算状況</h3>{current ? <span className={`rounded-full px-2.5 py-1 text-xs font-extrabold ${status?.tone}`}>{status?.label}</span> : null}</div>
    {state === "disabled" ? <p className="mt-2 text-[0.8125rem] text-ink-soft">料金・精算状況は現在確認できません。</p> : null}
    {state === "loading" ? <p role="status" className="mt-2 text-[0.8125rem] text-muted">料金・精算状況を確認しています…</p> : null}
    {state === "not-found" ? <div className="mt-2 text-[0.8125rem]"><p>この予約の料金記録は見つかりませんでした。</p></div> : null}
    {state === "network-error" || state === "error" ? <div role="alert" className="mt-2 text-[0.8125rem] font-bold text-danger"><p>{state === "network-error" ? "通信できず、料金・精算状況を確認できませんでした。" : "料金・精算状況の応答を確認できませんでした。"}</p></div> : null}
    {state === "expired" ? <p role="alert" className="mt-2 text-[0.8125rem] font-bold text-danger">接続または参照権限を確認できません。表示していた金額を消去しました。もう一度サインインしてください。</p> : null}
    {current && status ? <>
      <p className="mt-2 text-[0.8125rem] text-ink-soft">{status.detail}</p>
      {current.needsAttention ? <p className="mt-2 rounded-xl bg-warn-pale px-3 py-2 text-[0.8125rem] font-extrabold text-warn">NIHO事務局による記録照合が必要です。</p> : null}
      {current.feePolicy ? <div className="mt-3 rounded-xl bg-sand/55 p-3 text-[0.8125rem]"><div className="flex flex-wrap items-center gap-2"><strong>受付時 サポート{current.feePolicy.supportEnabled ? "ON" : "OFF"}</strong><span>{current.feePolicy.totalRateBps / 100}%（決済費用込み）</span></div><dl className="mt-2 grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1.5"><dt className="text-ink-soft">受付時の合計</dt><dd className="font-extrabold tabular-nums">{yen(current.feePolicy.originalGrossYen)}</dd><dt className="text-ink-soft">受付時のNIHO利用料</dt><dd className="font-extrabold tabular-nums">{yen(current.feePolicy.originalApplicationFeeYen)}</dd></dl><p className="mt-2 text-xs text-muted">通訳・お手伝いの人件費は含みません。必要な場合はホストから担当者へ直接支払います。</p></div> : <p className="mt-3 text-[0.8125rem] text-muted">受付時の料金条件は未確認です。</p>}
      {current.accounting ? <AmountRows accounting={current.accounting} audience={audience} /> : <p className="mt-3 text-[0.8125rem] text-muted">返金・精算の金額は未確認です。</p>}
      <p className="mt-3 text-xs text-muted">{current.evidenceCheckedAt ? `記録確認 ${adminDateTime(current.evidenceCheckedAt)}` : "記録確認時刻 未確認"}{current.settledAt ? ` · 精算確認 ${adminDateTime(current.settledAt)}` : ""}</p>
    </> : null}
    {enabled && state !== "expired" ? <div className="mt-2"><button type="button" onClick={retry} aria-disabled={state === "loading"} className="min-h-9 rounded-full border border-line-strong px-3 text-[0.8125rem] font-extrabold aria-disabled:opacity-50">{state === "loading" ? "確認中…" : state === "ready" ? "最新の記録を再取得" : state === "not-found" ? "もう一度確認" : "もう一度試す"}</button></div> : null}
  </section>;
}
