/* eslint-disable @next/next/no-img-element -- private authenticated media */
"use client";

import { useState } from "react";
import { WriteApiError, writeApi, type GuideResponse } from "@/lib/write/api";
import type { WriteCover, WriteMediaAsset } from "@/lib/write/client-types";

function upload(articleId: string, file: File, progress: (value: number) => void): Promise<{ asset: WriteMediaAsset }> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", `/write/api/guides/${encodeURIComponent(articleId)}/media`);
    request.setRequestHeader("content-type", file.type);
    request.upload.onprogress = (event) => { if (event.lengthComputable) progress(Math.round(event.loaded / event.total * 100)); };
    request.onerror = reject;
    request.onload = () => {
      if (request.status < 200 || request.status >= 300) { reject(new Error(String(request.status))); return; }
      try { resolve(JSON.parse(request.responseText) as { asset: WriteMediaAsset }); } catch { reject(new Error("invalid")); }
    };
    request.send(file);
  });
}

export function WriteCoverField({ articleId, cover, initialAssets, onChange, onBusy, beforeRevisionMutation, onRevoked, onConflict }: {
  readonly articleId: string;
  readonly cover: WriteCover | null;
  readonly initialAssets: readonly WriteMediaAsset[];
  readonly onChange: (cover: WriteCover | null) => void;
  readonly onBusy: (busy: boolean) => void;
  readonly beforeRevisionMutation: () => Promise<number | null>;
  readonly onRevoked: (guide: GuideResponse["guide"], assetId: string) => void;
  readonly onConflict: () => void;
}) {
  const [assets, setAssets] = useState(initialAssets);
  const [assetId, setAssetId] = useState(cover?.assetId ?? "");
  const [alt, setAlt] = useState(cover?.alt ?? "");
  const [credit, setCredit] = useState(cover?.credit ?? "");
  const [confirmed, setConfirmed] = useState(cover?.webConfirmed ?? false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [retryFile, setRetryFile] = useState<File | null>(null);
  const begin = () => { setBusy(true); onBusy(true); };
  const end = () => { setBusy(false); setProgress(null); onBusy(false); };
  const reload = async () => {
    const response = await writeApi<{ assets: WriteMediaAsset[] }>(`/write/api/guides/${encodeURIComponent(articleId)}/media`);
    setAssets(response.assets); return response.assets;
  };
  const uploadFile = async (file: File | null) => {
    if (!file || busy) return;
    if (!["image/jpeg", "image/png"].includes(file.type) || file.size > 10 * 1024 * 1024) { setError("JPEG / PNG（10MB以下）を選んでください。"); return; }
    setRetryFile(file); begin(); setError(""); setProgress(0);
    try {
      const response = await upload(articleId, file, setProgress);
      const next = await reload(); setAssets(next); setAssetId(response.asset.id); setAlt(""); setCredit(""); setConfirmed(false); setRetryFile(null);
    } catch { setError("アップロードできませんでした。"); }
    finally { end(); }
  };
  const select = (value: string) => {
    const asset = assets.find((item) => item.id === value);
    setAssetId(value); setCredit(asset?.publicCredit ?? ""); setConfirmed(asset?.webConfirmed ?? false); setAlt(cover?.assetId === value ? cover.alt : ""); setError("");
  };
  const apply = async () => {
    if (!assetId || !alt.trim() || !credit.trim() || !confirmed) { setError("写真、英語alt、公開クレジット、Web掲載許諾を確認してください。"); return; }
    begin(); setError("");
    try {
      await writeApi(`/write/api/guides/${encodeURIComponent(articleId)}/media/${encodeURIComponent(assetId)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ publicCredit: credit.trim(), webConfirmed: true }) });
      onChange({ assetId, alt: alt.trim(), credit: credit.trim(), webConfirmed: true });
    } catch { setError("カバーを設定できませんでした。"); }
    finally { end(); }
  };
  const revoke = async () => {
    if (!assetId || busy || !window.confirm("掲載権利を取り消すと、公開中の記事を含むすべての配置から直ちに外れます。取り消しますか？")) return;
    setBusy(true); setError("");
    let registered = false;
    try {
      const expectedRevision = await beforeRevisionMutation();
      if (expectedRevision === null) { setError("保存を完了できないため、権利を取り消せません。"); return; }
      onBusy(true); registered = true;
      const response = await writeApi<GuideResponse>(`/write/api/guides/${encodeURIComponent(articleId)}/media/${encodeURIComponent(assetId)}`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision }) });
      onRevoked(response.guide, assetId); setAssets((items) => items.filter((item) => item.id !== assetId)); setAssetId(""); setAlt(""); setCredit(""); setConfirmed(false);
    } catch (caught) {
      if (caught instanceof WriteApiError && caught.kind === "conflict") onConflict();
      setError("掲載権利を取り消せませんでした。最新版を確認してください。");
    }
    finally { setBusy(false); setProgress(null); if (registered) onBusy(false); }
  };
  const selected = assets.find((asset) => asset.id === assetId);
  return <div className="write-cover-field">
    <label>写真<select value={assetId} disabled={busy} onChange={(event) => select(event.target.value)}><option value="">カバーなし</option>{assets.map((asset) => <option key={asset.id} value={asset.id}>{asset.publicCredit ?? `未確認 ${asset.id.slice(0, 8)}`}</option>)}</select></label>
    <label>JPEG / PNGを追加（10MBまで）<input type="file" accept="image/jpeg,image/png" disabled={busy} onChange={(event) => { const file = event.currentTarget.files?.[0] ?? null; event.currentTarget.value = ""; void uploadFile(file); }} /></label>
    {progress !== null ? <p role="status">アップロード中 {progress}%</p> : null}
    {assetId ? <img src={`/write/api/guides/${encodeURIComponent(articleId)}/media/${encodeURIComponent(assetId)}`} alt="選択中のカバー" /> : null}
    {assetId ? <><label>英語alt<input maxLength={300} value={alt} disabled={busy} onChange={(event) => setAlt(event.target.value)} /></label><label>公開クレジット<input maxLength={300} value={credit} disabled={busy || selected?.webConfirmed} onChange={(event) => setCredit(event.target.value)} /></label><label className="write-check"><input type="checkbox" checked={confirmed} disabled={busy || selected?.webConfirmed} onChange={(event) => setConfirmed(event.target.checked)} />Webサイトへの掲載許諾を確認済み</label><p className="write-help">Web記事への掲載同意です。SNS・OG画像への利用許諾とは別です。</p><div className="write-inline-actions"><button type="button" disabled={busy} onClick={() => { setAssetId(""); onChange(null); }}>記事から外す（権利は保持）</button><button type="button" disabled={busy} onClick={() => void revoke()}>掲載権利を取り消す</button><button type="button" className="write-secondary" disabled={busy} onClick={() => void apply()}>カバーに設定</button></div></> : null}
    {error ? <p className="write-error" role="alert">{error} {retryFile ? <button type="button" onClick={() => void uploadFile(retryFile)}>再試行</button> : null}</p> : null}
  </div>;
}
