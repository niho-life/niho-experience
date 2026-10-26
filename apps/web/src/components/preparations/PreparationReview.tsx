"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ExperiencePreparationReview } from "@niho-experience/api-client/experience-preparations";
import { PreparationProposalView } from "./PreparationProposalView";

function errorMessage(status: number) {
  if (status === 401) return "確認の有効期限が切れました。事務局へ新しいリンクを依頼してください。";
  if (status === 404) return "この確認リンクは期限切れ、撤回済み、または原稿更新により失効しています。事務局へ新しいリンクを依頼してください。";
  return "内容を読み込めませんでした。通信を確認してもう一度お試しください。";
}

export function PreparationReview() {
  const token = useRef<string | null>(null);
  const loadVersion = useRef(0);
  const [review, setReview] = useState<ExperiencePreparationReview | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [sent, setSent] = useState(false);

  const load = useCallback(async (initial = false) => {
    const version = ++loadVersion.current;
    setLoading(true); setError("");
    try {
      const currentToken = initial ? token.current : null;
      const response = await fetch("/host/api/preparations/review", currentToken ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: currentToken }) } : { cache: "no-store" });
      if (!response.ok) {
        if (version === loadVersion.current && [400, 401, 404].includes(response.status)) token.current = null;
        throw new Error(errorMessage(response.status));
      }
      const next = await response.json() as ExperiencePreparationReview;
      if (version !== loadVersion.current) return;
      setReview(next);
      if (currentToken) token.current = null;
    } catch (reason) { if (version === loadVersion.current) { setReview(null); setError(reason instanceof Error ? reason.message : errorMessage(503)); } }
    finally { if (version === loadVersion.current) setLoading(false); }
  }, []);

  useEffect(() => {
    const consumeLink = () => {
      const fragment = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : "";
      if (fragment) { token.current = fragment; setReview(null); setSent(false); setMessage(""); }
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
      void load(Boolean(token.current));
    };
    const timer = window.setTimeout(consumeLink, 0);
    window.addEventListener("hashchange", consumeLink);
    return () => { window.clearTimeout(timer); window.removeEventListener("hashchange", consumeLink); };
  }, [load]);

  async function requestCorrection(event: React.FormEvent) {
    event.preventDefault(); setError(""); setSent(false);
    try {
      const response = await fetch("/host/api/preparations/review/correction", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message }) });
      if (!response.ok) throw new Error(errorMessage(response.status));
      setSent(true); setMessage("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : errorMessage(503)); }
  }

  return (
    <main id="main" className="mx-auto w-full max-w-3xl px-4 py-8 sm:py-12">
      <header><p className="text-xs font-extrabold tracking-[0.12em] text-ink-soft">PRIVATE REVIEW</p><h1 className="font-display text-3xl font-medium">掲載内容のご確認</h1><p className="mt-3 text-ink-soft">日本語の確認内容、公開する英語、販売条件、運営分担をご確認ください。このページだけでは店舗の管理権限は付きません。</p></header>
      {loading ? <p aria-live="polite" className="mt-8">読み込み中…</p> : null}
      {error ? <section role="alert" className="mt-8 rounded-2xl bg-danger-pale p-5 text-danger"><p>{error}</p><button type="button" className="mt-3 min-h-10 rounded-full border border-danger/40 px-5 font-extrabold" onClick={() => void load(Boolean(token.current))}>再試行</button></section> : null}
      {review ? <>
        <section className="mt-8 rounded-[1.5rem] border border-line bg-canvas p-5 shadow-sm sm:p-8"><div className="mb-6 flex flex-wrap items-center justify-between gap-2"><span className="rounded-full bg-sand px-3 py-1 text-xs font-extrabold">確認版 {review.revision}</span><span className="text-xs text-ink-soft">確認期限 {new Date(review.expiresAt).toLocaleString("ja-JP")}</span></div><PreparationProposalView proposal={review.proposal} images={review.images} /></section>
        <section className="mt-8 rounded-[1.5rem] border border-line bg-canvas p-5 sm:p-8"><h2 className="font-display text-2xl font-medium">この内容で進めますか？</h2><p className="mt-2 text-ink-soft">続ける場合はNIHOで本人認証し、5つの項目を一つずつ確認して正式に受け入れます。事務局が代わりに同意することはありません。</p><a href={`/host/auth/login?preparationCaseId=${encodeURIComponent(review.caseId)}`} className="mt-5 inline-flex min-h-10 items-center rounded-full bg-ink px-6 font-extrabold text-white">この内容で進める</a></section>
        <section className="mt-8 border-t border-line pt-8"><h2 className="font-display text-2xl font-medium">修正を依頼する</h2><form className="mt-4" onSubmit={requestCorrection}><label className="font-extrabold">直したい内容<textarea required maxLength={2000} rows={5} value={message} onChange={(event) => setMessage(event.target.value)} className="mt-2 w-full rounded-2xl border border-line-strong bg-canvas px-4 py-3" /></label><button className="mt-3 min-h-10 rounded-full border border-line-strong px-6 font-extrabold">修正依頼を送る</button></form>{sent ? <p role="status" className="mt-4 rounded-xl bg-leaf-pale p-4 text-moss">修正依頼を受け付けました。現在表示している原稿は、依頼時に確認した旧版のままです。事務局から届く新しい確認リンクで更新版をご確認ください。</p> : null}</section>
      </> : null}
    </main>
  );
}
