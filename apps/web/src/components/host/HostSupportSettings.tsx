"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  decodeExperienceHostSupportSettingsHostListResponse,
  decodeExperienceHostSupportSettingsStateResponse,
  type ExperienceHostSupportSettingsHostKind,
  type ExperienceHostSupportSettingsHostListResponse,
  type ExperienceHostSupportSettingsPutRequest,
  type ExperienceHostSupportSettingsStateResponse,
} from "@niho-experience/api-client/host-support-settings-schema";
import { hostSupportPath, HOST_HOME_PATH, HOST_LOGIN_PATH } from "@/lib/host/routes";
import { hostFetch } from "@/lib/host/client-session";
import {
  isSuccessfulHostSupportSave,
  resolveHostSupportRequestedTarget,
  type HostSupportTarget,
} from "@/lib/host/support-settings-ui";
import { FieldRow, FieldSection } from "./fields";
import { HostLoginLink } from "./HostAppWindow";
import { HostConfirmDialog } from "./HostConfirmDialog";
import { HostLeaveDialog, useHostLeaveGuard, type HostLeaveMode } from "./HostLeaveGuard";
import { consoleButtonClass, HOST_SURFACE } from "./host-ui";
import { HostSubHeader } from "./HostSubHeader";
import { HostPageBody, PageHead } from "./ui";

type Target = HostSupportTarget;
type TargetPhase = "none" | "loading" | "ready" | "error" | "forbidden" | "missing" | "invalid";
type Notice = { tone: "ok" | "warn" | "error"; text: string } | null;
type ActiveOperation = { sequence: number; generation: number; targetKey: string; abort: AbortController };

const targetKey = (target: Target) => `${target.kind}\0${target.id}`;
const targetMatches = (value: ExperienceHostSupportSettingsStateResponse, target: Target) => value.host.kind === target.kind && value.host.id === target.id;
const percent = (bps: number) => `${bps / 100}%`;

async function decoded<T>(response: Response, decode: (value: unknown) => T | null): Promise<T | null> {
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) return null;
  try { return decode(await response.json()); } catch { return null; }
}

function stateFingerprint(value: ExperienceHostSupportSettingsStateResponse): string {
  return JSON.stringify({ host: value.host, setting: value.setting, settingState: value.settingState, policy: value.policy, writeCapability: value.writeCapability });
}

function kindLabel(kind: ExperienceHostSupportSettingsHostKind): string {
  return kind === "SPOT" ? "通常拠点" : "外部提供者";
}

function phaseLabel(value: ExperienceHostSupportSettingsStateResponse) {
  if (value.settingState === "UNSET") return { label: "未設定", tone: "draft" as const };
  if (value.settingState === "RECONSENT_REQUIRED") return { label: "再同意が必要", tone: "wait" as const };
  return { label: value.setting?.enabled ? "サポートON" : "サポートOFF", tone: value.setting?.enabled ? "ok" as const : "draft" as const };
}

function errorText(status: number): string {
  if (status === 404) return "この設定対象は見つかりませんでした。";
  return "NIHOサポート設定を読み込めませんでした。時間をおいてもう一度お試しください。";
}

export function HostSupportSettings({ enabled, requestedKind, requestedId, malformedQuery = false }: { enabled: boolean; requestedKind?: string; requestedId?: string; malformedQuery?: boolean }) {
  const requested = useMemo(() => resolveHostSupportRequestedTarget(requestedKind, requestedId, malformedQuery), [malformedQuery, requestedId, requestedKind]);
  const [hosts, setHosts] = useState<ExperienceHostSupportSettingsHostListResponse | null>(null);
  const [listPhase, setListPhase] = useState<"loading" | "ready" | "error" | "forbidden" | "signed-out">(enabled ? "loading" : "ready");
  const [target, setTarget] = useState<Target | null>(null);
  const [detail, setDetail] = useState<ExperienceHostSupportSettingsStateResponse | null>(null);
  const [targetPhase, setTargetPhase] = useState<TargetPhase>("none");
  const [choice, setChoice] = useState<boolean | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [command, setCommand] = useState<Readonly<ExperienceHostSupportSettingsPutRequest> | null>(null);
  const [saving, setSaving] = useState(false);
  const [outcomeUnknown, setOutcomeUnknown] = useState(false);
  const [retryAvailable, setRetryAvailable] = useState(false);
  const [reconfirm, setReconfirm] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const operationController = useRef<AbortController | null>(null);
  const operationSequence = useRef(0);
  const saveLock = useRef(false);
  const stay = useRef<HTMLButtonElement>(null);
  const activeTarget = useRef<string | null>(null);

  const clearTarget = useCallback(() => {
    operationSequence.current += 1; operationController.current?.abort(); operationController.current = null; activeTarget.current = null; saveLock.current = false;
    setTarget(null); setDetail(null); setChoice(null); setCommand(null); setConfirming(false); setSaving(false); setOutcomeUnknown(false); setRetryAvailable(false); setReconfirm(false); setTargetPhase("none");
  }, []);

  const clearSignedOut = useCallback(() => {
    controller.current?.abort(); generation.current += 1; setHosts(null); clearTarget(); setListPhase("signed-out"); setNotice(null); saveLock.current = false;
  }, [clearTarget]);

  const readTarget = useCallback(async (selected: Target, signal: AbortSignal): Promise<{ kind: "ok"; value: ExperienceHostSupportSettingsStateResponse } | { kind: "status"; status: number } | { kind: "invalid" }> => {
    let response: Response;
    try { response = await hostFetch(`support-settings/${selected.kind}/${encodeURIComponent(selected.id)}`, { signal }); } catch { return { kind: "invalid" }; }
    if (!response.ok) return { kind: "status", status: response.status };
    const value = await decoded(response, decodeExperienceHostSupportSettingsStateResponse);
    return value && targetMatches(value, selected) ? { kind: "ok", value } : { kind: "invalid" };
  }, []);

  const applyTargetFailure = useCallback((selected: Target, failure: { kind: "status"; status: number } | { kind: "invalid" }) => {
    if (failure.kind === "status" && failure.status === 401) { clearSignedOut(); return; }
    setDetail(null); setChoice(null); setCommand(null); setConfirming(false); setOutcomeUnknown(false); setRetryAvailable(false);
    if (failure.kind === "status" && failure.status === 403) { setTargetPhase("forbidden"); setNotice(null); return; }
    setTargetPhase(failure.kind === "status" && failure.status === 404 ? "missing" : "error");
    setNotice({ tone: "error", text: failure.kind === "status" ? errorText(failure.status) : "NIHOから正しい形式の設定を受け取れませんでした。保存は行っていません。" });
    setTarget(selected);
  }, [clearSignedOut]);

  useEffect(() => {
    if (!enabled) return;
    const currentGeneration = ++generation.current;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    void (async () => {
      await Promise.resolve();
      if (abort.signal.aborted || generation.current !== currentGeneration) return;
      setListPhase("loading"); setHosts(null); clearTarget(); setNotice(null);
      let response: Response;
      try { response = await hostFetch("support-settings", { signal: abort.signal }); } catch { if (!abort.signal.aborted && generation.current === currentGeneration) setListPhase("error"); return; }
      if (abort.signal.aborted || generation.current !== currentGeneration) return;
      if (response.status === 401) { clearSignedOut(); return; }
      if (response.status === 403) { setListPhase("forbidden"); return; }
      if (!response.ok) { setListPhase("error"); return; }
      const list = await decoded(response, decodeExperienceHostSupportSettingsHostListResponse);
      if (abort.signal.aborted || generation.current !== currentGeneration) return;
      if (!list) { setListPhase("error"); return; }
      setHosts(list); setListPhase("ready");
      if (requested.kind === "invalid") { setTargetPhase("invalid"); return; }
      const selected = requested.kind === "valid" ? requested.target : list.hosts[0] ?? null;
      if (!selected) return;
      activeTarget.current = targetKey(selected); setTarget(selected);
      if (requested.kind === "valid" && !list.truncated && !list.hosts.some((item) => targetKey(item) === targetKey(selected))) { setTargetPhase("missing"); return; }
      setTargetPhase("loading");
      const result = await readTarget(selected, abort.signal);
      if (abort.signal.aborted || generation.current !== currentGeneration) return;
      if (result.kind !== "ok") { applyTargetFailure(selected, result); return; }
      setDetail(result.value); setChoice(result.value.setting?.enabled ?? null); setReconfirm(false); setTargetPhase("ready");
    })();
    return () => { abort.abort(); operationController.current?.abort(); };
  }, [applyTargetFailure, clearSignedOut, clearTarget, enabled, readTarget, requested]);

  const dirty = Boolean(detail && choice !== null && (reconfirm || detail.settingState !== "CURRENT" || choice !== detail.setting?.enabled));
  const leaveMode: HostLeaveMode = saving ? "saving" : outcomeUnknown ? "unknown" : dirty ? "dirty" : null;
  const leaveGuard = useHostLeaveGuard(leaveMode);

  const operationIsCurrent = useCallback((operation: ActiveOperation) => (
    !operation.abort.signal.aborted
    && operation.sequence === operationSequence.current
    && operation.generation === generation.current
    && operation.targetKey === activeTarget.current
  ), []);

  const beginOperation = useCallback((selected: Target): ActiveOperation | null => {
    if (saveLock.current || activeTarget.current !== targetKey(selected)) return null;
    const abort = new AbortController();
    operationController.current?.abort(); operationController.current = abort;
    const operation = { sequence: ++operationSequence.current, generation: generation.current, targetKey: targetKey(selected), abort };
    saveLock.current = true; setSaving(true); setNotice(null); setConfirming(false);
    return operation;
  }, []);

  const finishOperation = useCallback((operation: ActiveOperation) => {
    if (!operationIsCurrent(operation)) return;
    saveLock.current = false; setSaving(false);
    if (operationController.current === operation.abort) operationController.current = null;
  }, [operationIsCurrent]);

  const reconcileUnknown = useCallback(async (selected: Target, immutable: Readonly<ExperienceHostSupportSettingsPutRequest>, operation: ActiveOperation, allowRetry: boolean) => {
    const result = await readTarget(selected, operation.abort.signal);
    if (!operationIsCurrent(operation)) return;
    if (result.kind === "status" && result.status === 401) { clearSignedOut(); return; }
    if (result.kind === "status" && (result.status === 403 || result.status === 404)) {
      finishOperation(operation); applyTargetFailure(selected, result); return;
    }
    if (result.kind === "ok") {
      setDetail(result.value);
      setCommand(immutable);
      const canRetry = allowRetry && result.value.writeCapability.writable;
      setRetryAvailable(canRetry);
      setNotice({ tone: "warn", text: `保存の応答は確認できませんでした。現在見えている設定は「${result.value.settingState === "UNSET" ? "未設定" : result.value.setting?.enabled ? "ON" : "OFF"}」ですが、今回の保存成功を証明するものではありません。${canRetry ? "必要な場合は、同じ内容を一度だけ再送できます。" : result.value.writeCapability.writable ? "再送結果も不明なため、繰り返し送らず事務局へ確認してください。" : "現在は設定変更を受け付けていないため再送できません。確認を破棄すれば移動できます。"}` });
    } else {
      setRetryAvailable(allowRetry);
      setNotice({ tone: "warn", text: allowRetry ? "保存の応答も現在の設定も確認できませんでした。同じ内容を一度だけ再送するか、確認を破棄して移動してください。" : "再送結果も現在の設定も確認できませんでした。繰り返し送らず、事務局へ確認するか確認を破棄して移動してください。" });
    }
    finishOperation(operation);
  }, [applyTargetFailure, clearSignedOut, finishOperation, operationIsCurrent, readTarget]);

  const putCommand = useCallback(async (selected: Target, immutable: Readonly<ExperienceHostSupportSettingsPutRequest>, replay = false) => {
    const operation = beginOperation(selected);
    if (!operation) return;
    setOutcomeUnknown(false); setRetryAvailable(false);
    let response: Response | null = null;
    try {
      response = await hostFetch(`support-settings/${selected.kind}/${encodeURIComponent(selected.id)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(immutable), signal: operation.abort.signal });
    } catch { /* result is unknown; reconcile below */ }
    if (!operationIsCurrent(operation)) return;
    if (response?.status === 401) { clearSignedOut(); return; }
    if (response?.status === 403 || response?.status === 404) {
      finishOperation(operation); applyTargetFailure(selected, { kind: "status", status: response.status }); return;
    }
    if (response?.status === 409) {
      const result = await readTarget(selected, operation.abort.signal);
      if (!operationIsCurrent(operation)) return;
      if (result.kind === "status" && result.status === 401) { clearSignedOut(); return; }
      if (result.kind === "status" && (result.status === 403 || result.status === 404)) {
        finishOperation(operation); applyTargetFailure(selected, result); return;
      }
      if (result.kind === "ok") setDetail(result.value);
      setCommand(null); setOutcomeUnknown(false); setRetryAvailable(false); setReconfirm(true);
      setNotice({ tone: "warn", text: result.kind === "ok"
        ? result.value.writeCapability.writable
          ? "ほかの変更が先に保存されました。入力は残しています。現在の内容を確認して、もう一度確認画面へ進んでください。"
          : "ほかの変更が先に保存され、現在は設定変更を受け付けていません。入力内容は保存されていません。"
        : "ほかの変更が先に保存されましたが、現在の内容を読み直せませんでした。入力は残しています。もう一度確認画面へ進み、再確認してください。" });
      finishOperation(operation);
      return;
    }
    const value = response?.ok ? await decoded(response, decodeExperienceHostSupportSettingsStateResponse) : null;
    if (!operationIsCurrent(operation)) return;
    if (isSuccessfulHostSupportSave(value, selected, immutable)) {
      setDetail(value); setChoice(value.setting!.enabled); setCommand(null); setOutcomeUnknown(false); setRetryAvailable(false); setReconfirm(false);
      setNotice({ tone: "ok", text: "NIHOサポート設定を保存しました。変更後に受け付ける新しい予約から適用されます。売上・返金の精算は各予約の明細で確認してください。" });
      finishOperation(operation);
      return;
    }
    setOutcomeUnknown(true); setCommand(immutable);
    await reconcileUnknown(selected, immutable, operation, !replay);
  }, [applyTargetFailure, beginOperation, clearSignedOut, finishOperation, operationIsCurrent, readTarget, reconcileUnknown]);

  const confirmSave = useCallback(async () => {
    if (!target || !detail || !command) return;
    const operation = beginOperation(target);
    if (!operation) return;
    const before = detail;
    const immutable = command;
    const latest = await readTarget(target, operation.abort.signal);
    if (!operationIsCurrent(operation)) return;
    if (latest.kind === "status" && latest.status === 401) { clearSignedOut(); return; }
    if (latest.kind === "status" && (latest.status === 403 || latest.status === 404)) {
      finishOperation(operation); applyTargetFailure(target, latest); return;
    }
    if (latest.kind !== "ok") {
      setCommand(null); setReconfirm(true); setTargetPhase("ready");
      setNotice({ tone: "warn", text: "保存前の再確認ができませんでした。選択は残しています。通信が戻ってから、もう一度確認画面へ進んでください。" });
      finishOperation(operation); return;
    }
    if (stateFingerprint(latest.value) !== stateFingerprint(before)) {
      setDetail(latest.value); setCommand(null);
      setReconfirm(true);
      setNotice({ tone: "warn", text: "確認中に設定・規約・変更可否が変わりました。入力は残しています。最新の内容を確認し、もう一度確認画面へ進んでください。" });
      finishOperation(operation);
      return;
    }
    finishOperation(operation);
    await putCommand(target, immutable);
  }, [applyTargetFailure, beginOperation, clearSignedOut, command, detail, finishOperation, operationIsCurrent, putCommand, readTarget, target]);

  const reloadTarget = useCallback(async () => {
    if (!target) return;
    const operation = beginOperation(target);
    if (!operation) return;
    setTargetPhase("loading");
    const result = await readTarget(target, operation.abort.signal);
    if (!operationIsCurrent(operation)) return;
    if (result.kind === "status" && result.status === 401) { clearSignedOut(); return; }
    if (result.kind !== "ok") {
      finishOperation(operation); applyTargetFailure(target, result); return;
    }
    setDetail(result.value); setChoice(result.value.setting?.enabled ?? null); setCommand(null); setOutcomeUnknown(false); setRetryAvailable(false); setReconfirm(false); setTargetPhase("ready");
    finishOperation(operation);
  }, [applyTargetFailure, beginOperation, clearSignedOut, finishOperation, operationIsCurrent, readTarget, target]);

  const openConfirmation = () => {
    if (!detail || !target || choice === null || !detail.writeCapability.writable || !dirty) return;
    const immutable = Object.freeze({ enabled: choice, consentVersion: detail.policy.consentVersion, expectedRevision: detail.setting?.revision ?? 0 });
    setCommand(immutable); setConfirming(true); setNotice(null);
  };

  const discardUnknown = () => { setOutcomeUnknown(false); setRetryAvailable(false); setCommand(null); setReconfirm(false); setChoice(detail?.setting?.enabled ?? null); };

  if (!enabled) return <><HostSubHeader backHref={HOST_HOME_PATH} backLabel="ホーム" title="NIHOサポート"/><HostPageBody><PageHead title="NIHOサポート"/><section className={`${HOST_SURFACE} p-5`}><h2 className="font-bold">この設定は準備中です</h2><p className="mt-2 text-ink-soft">準備が整うまで、設定の読み込みと保存は利用できません。</p></section></HostPageBody></>;

  return <>
    <HostSubHeader backHref={HOST_HOME_PATH} backLabel="ホーム" title="NIHOサポート" />
    <HostPageBody>
      <PageHead title="NIHOサポート" />
      <p className="mb-4 max-w-3xl text-ink-soft">ご本人が現在管理している通常拠点または外部提供者ごとに、NIHO事務局のサポートを設定します。</p>
      {listPhase === "loading" ? <p role="status">設定できる対象を読み込んでいます…</p> : null}
      {listPhase === "signed-out" ? <section role="alert" className={`${HOST_SURFACE} p-5`}><h2 className="font-bold">もう一度ログインしてください</h2><p className="mt-2 text-ink-soft">NIHOとの接続が終了したため、読み込んだ設定と入力を消去しました。</p><HostLoginLink href={HOST_LOGIN_PATH} className={`${consoleButtonClass("primary")} mt-4`}>NIHOでログイン</HostLoginLink></section> : null}
      {listPhase === "forbidden" ? <section role="alert" className={`${HOST_SURFACE} p-5`}><h2 className="font-bold">設定対象を確認できません</h2><p className="mt-2 text-ink-soft">NIHOでご本人が現在管理している対象を確認できませんでした。事務局の権限で代わりに変更することはありません。</p></section> : null}
      {listPhase === "error" ? <section role="alert" className={`${HOST_SURFACE} p-5`}><h2 className="font-bold">設定対象を読み込めませんでした</h2><p className="mt-2 text-ink-soft">対象が0件なのではなく、NIHOへの接続に失敗しています。</p><button type="button" onClick={() => window.location.reload()} className={`${consoleButtonClass("secondary")} mt-4`}>もう一度読み込む</button></section> : null}
      {listPhase === "ready" && hosts?.hosts.length === 0 ? <section className={`${HOST_SURFACE} p-5`}><h2 className="font-bold">設定できる対象はありません</h2><p className="mt-2 text-ink-soft">現在管理している通常拠点または外部提供者がありません。通常拠点の設定確認に提供者登録は必要ありません。</p>{hosts.truncated ? <p className="mt-2 font-bold text-warn">一覧は上限に達しています。表示外の対象がある可能性があります。</p> : null}</section> : null}
      {listPhase === "ready" && hosts && hosts.hosts.length > 0 ? <div className="grid gap-4 md:grid-cols-[240px_minmax(0,1fr)] md:items-start">
        <aside className={`${HOST_SURFACE} p-2.5`} aria-label="設定対象">
          <ul className="space-y-1">{hosts.hosts.map((item) => <li key={targetKey(item)}><Link href={hostSupportPath(item.kind, item.id)} aria-current={target && targetKey(item) === targetKey(target) ? "page" : undefined} className={`block min-h-12 rounded-xl px-3 py-2 ${target && targetKey(item) === targetKey(target) ? "bg-sand" : "hover:bg-sand"}`}><strong className="block break-words">{item.displayName}</strong><span className="text-xs text-muted">{kindLabel(item.kind)}</span></Link></li>)}</ul>
          {hosts.truncated ? <p className="mt-2 border-t border-line px-2 pt-2 text-xs font-bold text-warn">最大{hosts.limit}件まで表示しています。全件ではありません。</p> : null}
        </aside>
        <div className="min-w-0">
          {targetPhase === "loading" ? <p role="status">現在の設定を読み込んでいます…</p> : null}
          {targetPhase === "invalid" ? <section role="alert" className={`${HOST_SURFACE} p-5`}><h2 className="font-bold">設定対象を選び直してください</h2><p className="mt-2 text-ink-soft">URLの対象指定が正しくないため、別の対象を自動では開きません。左の一覧から選んでください。</p></section> : null}
          {targetPhase === "forbidden" ? <section role="alert" className={`${HOST_SURFACE} p-5`}><h2 className="font-bold">この設定は開けません</h2><p className="mt-2 text-ink-soft">ご本人が現在管理している対象として確認できませんでした。事務局の権限で代わりに変更することはありません。</p></section> : null}
          {targetPhase === "missing" ? <section role="alert" className={`${HOST_SURFACE} p-5`}><h2 className="font-bold">設定対象が見つかりません</h2><p className="mt-2 text-ink-soft">対象が削除されたか、現在のオーナーではありません。</p></section> : null}
          {targetPhase === "error" ? <section role="alert" className={`${HOST_SURFACE} p-5`}><h2 className="font-bold">現在の設定を読み込めませんでした</h2><p className="mt-2 text-ink-soft">未設定とは扱わず、保存も行いません。</p><button type="button" disabled={saving} onClick={() => void reloadTarget()} className={`${consoleButtonClass("secondary")} mt-4`}>現在の設定をもう一度読み込む</button></section> : null}
          {targetPhase === "ready" && detail ? <FieldSection id="support-setting-heading" title={`${detail.host.displayName} · ${kindLabel(detail.host.kind)}`} status={phaseLabel(detail)}>
            {detail.settingState === "UNSET" ? <p className="mb-3 rounded-xl bg-sand p-3 text-[0.8125rem] text-ink-soft">まだ選ばれていません。ONまたはOFFを選び、内容を確認して同意すると保存できます。</p> : null}
            {detail.settingState === "RECONSENT_REQUIRED" ? <p className="mb-3 rounded-xl bg-warn-pale p-3 text-[0.8125rem] font-bold text-warn">以前の設定は現在の規約版では有効ではありません。ON/OFFを確認し、現在版へ同意し直してください。</p> : null}
            <FieldRow label="利用設定" labelId="support-choice"><div role="radiogroup" aria-labelledby="support-choice" className="flex flex-col gap-2 sm:flex-row">{([false, true] as const).map((value) => <label key={String(value)} className={`relative flex min-h-12 flex-1 items-center rounded-xl border px-3 py-2 font-extrabold ${choice === value ? "border-ink bg-sand" : "border-line-strong bg-canvas"}`}><input type="radio" name="support-setting" checked={choice === value} disabled={!detail.writeCapability.writable || saving || outcomeUnknown} onChange={() => { setChoice(value); setReconfirm(false); setNotice(null); }} className="absolute inset-0 size-full cursor-pointer appearance-none rounded-xl disabled:cursor-not-allowed"/><span>サポート{value ? "ON" : "OFF"} · 合計手数料 {percent(value ? detail.policy.onTotalRateBps : detail.policy.offTotalRateBps)}</span></label>)}</div>{!detail.writeCapability.writable ? <p className="mt-2 text-xs font-bold text-warn">現在は設定変更を受け付けていません。現在の内容は確認できますが保存できません。</p> : null}</FieldRow>
            <FieldRow label="支援範囲" labelId="support-scope"><div id="support-scope" className="space-y-1 text-[0.8125rem] text-ink-soft"><p>ONは予約情報をNIHO事務局と共有し、相談に沿った通常の予約対応を任せる設定です。</p><p>通訳の紹介、料理補助、地元の方への声かけ、返金連絡などは個別に相談します。内容や担当者の確保を保証するものではなく、通訳だけを個別に申し込む設定ではありません。</p><p>OFFでも事務局による基本的な予約情報の確認は残ります。</p></div></FieldRow>
            <FieldRow label="費用" labelId="support-cost"><div id="support-cost" className="space-y-1 text-[0.8125rem] text-ink-soft"><p>OFFは合計{percent(detail.policy.offTotalRateBps)}、ONは合計{percent(detail.policy.onTotalRateBps)}（いずれも決済手数料込み）です。</p><p>担当者の人件費は別で、ホストから担当者へ直接支払います。全額キャンセル・返金で戻らない決済費用はNIHOが負担します。</p><p>売上・返金の精算は、設定の保存後も各予約の明細で確認してください。</p></div></FieldRow>
            <FieldRow label="適用" labelId="support-timing"><p id="support-timing" className="text-[0.8125rem] text-ink-soft">変更後に受け付ける新しい予約だけに適用します。過去の予約の許可・料金は変わりません。</p></FieldRow>
            {detail.setting?.sharedConsultationMemo ? <FieldRow label="相談メモ" labelId="support-memo"><p id="support-memo" className="whitespace-pre-wrap text-[0.8125rem] text-ink-soft">{detail.setting.sharedConsultationMemo}</p><p className="mt-1 text-xs text-muted">NIHO事務局と共有済みの内容（読み取りのみ）· 合意版 {detail.setting.agreementRevision}</p></FieldRow> : null}
            <div className="border-t border-line pt-3 md:pl-[184px]"><button type="button" disabled={!dirty || !detail.writeCapability.writable || saving || outcomeUnknown} onClick={openConfirmation} className={consoleButtonClass("primary", "md", "disabled:cursor-not-allowed disabled:opacity-50")}>{saving ? "確認中…" : detail.settingState === "RECONSENT_REQUIRED" ? "現在版を確認して同意" : "変更内容を確認"}</button>{outcomeUnknown && retryAvailable && command && target && detail.writeCapability.writable ? <button type="button" disabled={saving} onClick={() => void putCommand(target, command, true)} className={`${consoleButtonClass("secondary")} ml-2`}>同じ内容を再送</button> : null}{notice ? <p role={notice.tone === "error" ? "alert" : "status"} className={`mt-2 text-[0.8125rem] font-bold ${notice.tone === "ok" ? "text-moss" : notice.tone === "warn" ? "text-warn" : "text-danger"}`}>{notice.text}</p> : null}</div>
          </FieldSection> : null}
        </div>
      </div> : null}
    </HostPageBody>
    {confirming && detail && command && choice !== null ? <HostConfirmDialog title={`${detail.host.displayName}のサポートを${choice ? "ON" : "OFF"}にしますか？`} description={`規約版 ${detail.policy.policyVersion}。合計手数料は${percent(choice ? detail.policy.onTotalRateBps : detail.policy.offTotalRateBps)}（決済手数料込み）です。`} focusRef={stay} stayRef={stay} confirm={<button type="submit" disabled={saving} className={consoleButtonClass("primary")}>同意して保存</button>} onConfirm={() => void confirmSave()} onClose={() => { setConfirming(false); setCommand(null); }}><div className="mt-4 space-y-2 rounded-xl bg-sand p-3 text-[0.8125rem] text-ink-soft"><p>対象: <strong className="text-ink">{detail.host.displayName}（{kindLabel(detail.host.kind)}）</strong></p><p>ONでは予約情報を共有し、相談に沿う通常の予約対応を任せます。内容や担当者の確保は保証されません。OFFでも事務局による基本的な予約情報の確認は残ります。</p><p>人件費は別途ホストから担当者へ直接支払います。変更後の新規予約だけに適用し、過去予約は変えません。</p><label className="flex items-start gap-2 pt-1 font-bold text-ink"><input required type="checkbox" className="mt-1 size-4 shrink-0"/>対象・ON/OFF・費用・支援範囲・適用時期と規約版を確認し、同意します</label></div></HostConfirmDialog> : null}
    {leaveGuard.asking && leaveMode ? <HostLeaveDialog mode={leaveMode} requestKey={leaveGuard.requestKey} onStay={leaveGuard.stay} onLeave={leaveGuard.leave} onDiscard={leaveMode === "unknown" ? discardUnknown : undefined} /> : null}
  </>;
}
