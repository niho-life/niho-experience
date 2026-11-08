"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { hostFetch } from "@/lib/host/client-session";
import { HOST_SETTINGS_PATH, withProvider } from "@/lib/host/routes";
import { FieldRow, FieldSection } from "./fields";
import { HostConfirmDialog } from "./HostConfirmDialog";
import { HostLeaveDialog, useHostLeaveGuard, type HostLeaveMode } from "./HostLeaveGuard";
import { consoleButtonClass } from "./host-ui";
import { HostSubHeader } from "./HostSubHeader";
import { HostSettingsBackLink } from "./HostSettingsBackLink";
import { HostPageBody, PageHead } from "./ui";

const CONSENT_VERSION = "2026-10-23";
type SavedSetting = {
  providerId: string;
  supportEnabled: boolean;
  platformFeeBasisPoints: 1000 | 1500;
  supportConsentVersion: string | null;
  supportAgreementRevision: number | null;
  version: number;
};
type State = { setting: SavedSetting | null };
type Notice = { tone: "success" | "warning" | "error"; text: string } | null;

function isState(value: unknown, providerId: string): value is State {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const setting = (value as { setting?: unknown }).setting;
  if (setting === null) return true;
  if (!setting || typeof setting !== "object" || Array.isArray(setting)) return false;
  const data = setting as Record<string, unknown>;
  return data.providerId === providerId && typeof data.supportEnabled === "boolean"
    && (data.platformFeeBasisPoints === 1000 || data.platformFeeBasisPoints === 1500)
    && (data.supportConsentVersion === null || typeof data.supportConsentVersion === "string")
    && (data.supportAgreementRevision === null || Number.isSafeInteger(data.supportAgreementRevision))
    && Number.isSafeInteger(data.version);
}

async function readState(providerId: string, signal?: AbortSignal): Promise<{ ok: true; state: State } | { ok: false; status: number }> {
  let response: Response;
  try { response = await hostFetch(`/experience-support-settings/${encodeURIComponent(providerId)}`, { signal }); }
  catch { return { ok: false, status: 0 }; }
  if (!response.ok) return { ok: false, status: response.status };
  const value: unknown = await response.json().catch(() => null);
  return isState(value, providerId) ? { ok: true, state: value } : { ok: false, status: 502 };
}

function loadError(status: number): string {
  if (status === 401) return "ログインの有効期限が切れました。NIHOにログインし直してください。";
  if (status === 403) return "現在のオーナーだけがこの設定を確認・変更できます。";
  return "設定を読み込めませんでした。入力は残しています。通信が戻ってから再読み込みしてください。";
}

export function HostExperienceSupportSettings({ providerId, displayName }: { providerId: string; displayName: string }) {
  const [saved, setSaved] = useState<SavedSetting | null>(null);
  const [hasSaved, setHasSaved] = useState(false);
  const [choice, setChoice] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const stay = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const abort = new AbortController();
    void readState(providerId, abort.signal).then((result) => {
      if (abort.signal.aborted) return;
      if (!result.ok) {
        setNotice({ tone: result.status === 401 || result.status === 403 ? "warning" : "error", text: loadError(result.status) });
        return;
      }
      setSaved(result.state.setting);
      setHasSaved(true);
      setNotice(null);
    }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [providerId, refreshKey]);

  const refresh = () => {
    setLoading(true);
    setRefreshKey((value) => value + 1);
  };

  const currentConsent = saved?.supportConsentVersion === CONSENT_VERSION && (saved.supportAgreementRevision ?? 0) > 0;
  const dirty = choice !== null && (saved === null || !currentConsent || choice !== saved.supportEnabled);
  const leaveMode: HostLeaveMode = saving ? "saving" : dirty ? "dirty" : null;
  const leaveGuard = useHostLeaveGuard(leaveMode);
  const save = async () => {
    if (choice === null || !dirty || saving) return;
    const expectedVersion = saved?.version ?? 0;
    setSaving(true);
    setConfirming(false);
    setNotice(null);
    let response: Response | null = null;
    try {
      response = await hostFetch(`/experience-support-settings/${encodeURIComponent(providerId)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ supportEnabled: choice, expectedVersion, consentVersion: CONSENT_VERSION }),
      });
    } catch { /* reconcile an unknown response below */ }
    const result = await readState(providerId);
    setSaving(false);
    if (!result.ok) {
      setNotice({ tone: "warning", text: "保存結果を確認できませんでした。選択は残しています。再読み込みして現在値を確認してください。" });
      return;
    }
    const state = result.state.setting;
    const accepted = state?.supportEnabled === choice && state.supportConsentVersion === CONSENT_VERSION
      && state.version === expectedVersion + 1;
    setSaved(state);
    setHasSaved(true);
    if (accepted && response?.ok) {
      setChoice(null);
      setNotice({ tone: "success", text: "同意を保存しました。これから受け付ける新しい予約に適用されます。すでにある予約の設定は変わりません。" });
    } else if (accepted) {
      setChoice(null);
      setNotice({ tone: "success", text: "設定は保存されています。通信応答は失われましたが、現在値で保存を確認しました。" });
    } else if (response?.status === 401) {
      setNotice({ tone: "warning", text: loadError(401) });
    } else if (response?.status === 403 || response?.status === 404) {
      setNotice({ tone: "warning", text: loadError(response.status) });
    } else {
      setNotice({ tone: "warning", text: "ほかの更新が先に反映されたか、保存結果を確認できませんでした。入力は残しています。現在値を確認してから、もう一度同意してください。" });
    }
  };

  const fee = choice ?? saved?.supportEnabled ?? false;
  return <>
    <HostSubHeader backHref={withProvider(HOST_SETTINGS_PATH, providerId)} backLabel="設定" title="NIHOサポート" />
    <HostPageBody>
      <HostSettingsBackLink providerId={providerId} desktopOnly />
      <PageHead title="ExperienceのNIHOサポート" />
      <p className="mb-4 max-w-3xl text-ink-soft">{displayName}で新しく受け付ける予約の支援範囲と手数料を設定します。</p>
      <FieldSection id="experience-support-setting" title={displayName} status={currentConsent ? { label: saved?.supportEnabled ? "サポートON" : "サポートOFF", tone: saved?.supportEnabled ? "ok" : "draft" } : { label: "同意が必要", tone: "wait" }}>
        {loading ? <p role="status">現在の設定を読み込んでいます…</p> : null}
        {!loading && !hasSaved ? <div role="alert" className="rounded-xl bg-warn-pale p-3 text-sm text-warn"><p>{notice?.text ?? "現在の設定を確認できませんでした。未設定とは扱わず、保存は行いません。"}</p><button type="button" className={`${consoleButtonClass("secondary")} mt-3`} onClick={refresh}>もう一度読み込む</button></div> : null}
        {hasSaved ? <>
          {!currentConsent ? <p className="mb-3 rounded-xl bg-warn-pale p-3 text-sm font-bold text-warn">この提供者のExperience予約には現在の同意がありません。以前の設定や過去の予約には同意を補いません。ONまたはOFFを選び、現在の条件を確認してください。</p> : null}
          <FieldRow label="利用設定" labelId="experience-support-choice">
            <div role="radiogroup" aria-labelledby="experience-support-choice" className="grid gap-2 sm:grid-cols-2">
              {[false, true].map((value) => <label key={String(value)} className={`relative flex min-h-12 items-center rounded-xl border px-3 py-2 font-extrabold ${choice === value ? "border-ink bg-sand" : "border-line-strong bg-canvas"}`}>
                <input type="radio" name="experience-support" checked={choice === value} disabled={saving || loading} onChange={() => { setChoice(value); setNotice(null); }} className="absolute inset-0 size-full cursor-pointer appearance-none rounded-xl disabled:cursor-not-allowed" />
                <span>サポート{value ? "ON" : "OFF"} · 合計手数料 {value ? "15%" : "10%"}</span>
              </label>)}
            </div>
          </FieldRow>
          <FieldRow label="支援内容" labelId="experience-support-scope"><div id="experience-support-scope" className="space-y-1 text-sm text-ink-soft"><p>ONでは、予約情報をNIHO事務局と共有し、予約前後の問い合わせ、予約の確認、取消・返金の連絡を支援します。</p><p>追加の人件費や通訳手配はこの設定に含みません。個別の担当・対応を保証するものではありません。</p></div></FieldRow>
          <FieldRow label="費用と適用" labelId="experience-support-fee"><div id="experience-support-fee" className="space-y-1 text-sm text-ink-soft"><p>サポートOFFは合計10%、ONは合計15%です。いずれも決済費用込みです。</p><p>取消・返金後に返らない決済費用はNIHOが負担します。過去予約の同意や手数料は変更しません。</p><p>変更は保存後に受け付ける予約だけに適用し、各予約に選択・料金・同意版を固定します。</p></div></FieldRow>
          <FieldRow label="同意版" labelId="experience-support-consent"><p id="experience-support-consent" className="text-sm text-ink-soft">Experienceサポート規約 {CONSENT_VERSION}{saved?.supportAgreementRevision ? ` · 現在の同意改訂 ${saved.supportAgreementRevision}` : " · 未同意"}</p></FieldRow>
          <div className="border-t border-line pt-3 md:pl-[184px]">
            <button type="button" disabled={!dirty || choice === null || saving || loading} onClick={() => setConfirming(true)} className={consoleButtonClass("primary", "md", "disabled:cursor-not-allowed disabled:opacity-50")}>{saving ? "保存中…" : "選択内容を確認"}</button>
            <button type="button" disabled={saving || loading} onClick={refresh} className={`${consoleButtonClass("secondary")} ml-2`}>現在値を再読み込み</button>
            {notice ? <p role={notice.tone === "error" ? "alert" : "status"} className={`mt-2 text-sm font-bold ${notice.tone === "success" ? "text-moss" : notice.tone === "warning" ? "text-warn" : "text-danger"}`}>{notice.text}</p> : null}
          </div>
        </> : null}
      </FieldSection>
      <p className="mt-4 text-sm"><Link href="/host/support" className="underline">支援設定の対象一覧へ戻る</Link></p>
      {confirming ? <HostConfirmDialog focusRef={stay} stayRef={stay} title={`${displayName}のサポートを${fee ? "ON" : "OFF"}にしますか？`} description={`Experienceサポート規約 ${CONSENT_VERSION} に同意します。新規予約から合計${fee ? "15%" : "10%"}（決済費用込み）が適用されます。`} confirm={<button type="submit" disabled={saving} className={consoleButtonClass("primary")}>同意して保存</button>} onConfirm={() => void save()} onClose={() => setConfirming(false)}><div className="mt-4 space-y-2 rounded-xl bg-sand p-3 text-sm text-ink-soft"><p>ONではNIHO事務局と予約情報を共有し、予約前後の問い合わせ・確認・取消返金の連絡を支援します。</p><p>追加の人件費・通訳手配は含まず、個別の対応を保証しません。過去の予約には適用しません。</p><label className="flex items-start gap-2 pt-1 font-bold text-ink"><input type="checkbox" required className="mt-1 size-4 shrink-0" />サポート範囲・合計手数料・決済費用・適用時期と規約版を確認し、同意します</label></div></HostConfirmDialog> : null}
      {leaveGuard.asking && leaveMode ? <HostLeaveDialog mode={leaveMode} requestKey={leaveGuard.requestKey} onStay={leaveGuard.stay} onLeave={leaveGuard.leave} /> : null}
    </HostPageBody>
  </>;
}
