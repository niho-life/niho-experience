"use client";

import { useState } from "react";
import type { ExperienceAdminHost } from "@niho-experience/experience-store";
import { HOST_SUSPENSION_REASONS, hostSuspensionReasonLabel } from "@/lib/admin/host-operations";

const API = "/admin/api/hosts";
const BUTTON = "min-h-11 rounded-full border border-line-strong px-4 font-extrabold hover:bg-sand disabled:opacity-50";
const FIELD = "min-h-11 rounded-xl border border-line-strong bg-canvas px-3 font-normal";

const date = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" }) : "なし");

const FAILURE: Record<string, string> = {
  not_found: "見つかりませんでした。一覧を読み込み直してください。",
  invalid_input: "入力が正しくありません。",
  forbidden: "この操作はできません。ページを開き直してください。",
  unauthenticated: "ログインが切れました。ログインし直してください。",
  blocked: "いまはできません。",
  conflict: "ほかの操作と重なりました。読み込み直してもう一度お試しください。",
};

/**
 * ホストの一覧 (#711): how each host registered, what is public and selling, and the office's two stops: the host as a whole
 * (its public experiences close, new pages and bookings stay closed) and each owner's sign-in account. Every stop asks first.
 */
export function AdminHosts({ initial }: { initial: readonly ExperienceAdminHost[] }) {
  const [hosts, setHosts] = useState(initial);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reasons, setReasons] = useState<Record<string, string>>({});

  async function reload() {
    const response = await fetch(API, { cache: "no-store", credentials: "same-origin" });
    if (!response.ok) throw new Error("reload failed");
    setHosts(((await response.json()) as { hosts: ExperienceAdminHost[] }).hosts);
  }

  async function act(path: string, body: unknown, ask: string, done: (result: Record<string, unknown>) => string) {
    if (!window.confirm(ask)) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`${API}/${path}`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const result = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (!response.ok) setMessage(`失敗しました。${FAILURE[String(result.error)] ?? "しばらくしてからもう一度お試しください。"}`);
      else { setMessage(done(result)); await reload().catch(() => setMessage("操作は済みましたが、一覧を読み込み直せませんでした。")); }
    } catch { setMessage("通信に失敗しました。結果を確かめてからやり直してください。"); }
    finally { setBusy(false); }
  }

  return (
    <div className="mx-auto max-w-6xl space-y-5 px-4 py-8 md:px-7">
      <div>
        <h1 className="font-display text-2xl font-medium">ホスト</h1>
        <p className="mt-1 text-ink-soft">ホストの登録の経路と、公開・受付の状態です。メールアドレスを含むので、この画面の内容は外に貼らないでください。</p>
      </div>
      {message ? <p role="status" className="rounded-xl border border-line-strong bg-sand px-4 py-3">{message}</p> : null}
      {hosts.length === 0 ? <p className="text-ink-soft">ホストはまだありません。</p> : null}
      <ul className="space-y-4">
        {hosts.map((host) => {
          const suspended = host.operationsSuspendedAtUtc !== null;
          const reason = reasons[host.providerId] ?? HOST_SUSPENSION_REASONS[0].code;
          return (
            <li key={host.providerId} className="space-y-3 rounded-2xl border border-line-strong p-4">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <h2 className="text-lg font-extrabold">{host.publicDisplayName ?? "（公開名なし）"}</h2>
                {host.publicDisplayNameEn ? <span className="text-ink-soft">{host.publicDisplayNameEn}</span> : null}
                <span className="font-mono text-xs text-ink-soft">{host.providerId}</span>
                {suspended ? <span role="status" className="rounded-full bg-sand px-3 py-1 text-sm font-extrabold">運営停止中（{hostSuspensionReasonLabel(host.operationsSuspensionCode)}・{date(host.operationsSuspendedAtUtc)}）</span> : null}
              </div>
              <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2 lg:grid-cols-3">
                <div><dt className="inline text-ink-soft">種別：</dt><dd className="inline">{host.providerKind === "BUSINESS" ? "事業者" : host.providerKind === "PERSON" ? "個人" : "未設定"}</dd></div>
                <div><dt className="inline text-ink-soft">登録の経路：</dt><dd className="inline">{host.route === "SELF" ? "自分で登録" : "事務局"}</dd></div>
                <div><dt className="inline text-ink-soft">公開名の同意：</dt><dd className="inline">{host.consentSource === "OWNER" ? "本人" : host.consentSource === "ADMIN" ? "事務局" : "なし"}</dd></div>
                <div><dt className="inline text-ink-soft">登録日：</dt><dd className="inline">{date(host.registeredAtUtc)}</dd></div>
                <div><dt className="inline text-ink-soft">公開中のページ：</dt><dd className="inline">{host.publicPages}</dd></div>
                <div><dt className="inline text-ink-soft">予約受付中：</dt><dd className="inline">{host.sellingPages}</dd></div>
                <div><dt className="inline text-ink-soft">最初のページ公開：</dt><dd className="inline">{date(host.firstPublishedAtUtc)}</dd></div>
                <div><dt className="inline text-ink-soft">最初の予約受付：</dt><dd className="inline">{date(host.firstBookingOpenedAtUtc)}</dd></div>
              </dl>
              <div className="space-y-2 text-sm">
                <p className="text-ink-soft">オーナー</p>
                {host.owners.length === 0 && !host.hasOtherOwner ? <p>オーナーはいません。</p> : null}
                {host.hasOtherOwner ? <p>NIHO アカウントのオーナーがいます（この画面では操作できません）。</p> : null}
                <ul className="space-y-2">
                  {host.owners.map((owner) => (
                    <li key={owner.hostAccountId} className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs">{owner.hostAccountId}</span>
                      <span>{owner.email ?? "メールアドレスなし"}</span>
                      <span className="font-extrabold">{owner.status === "ACTIVE" ? "利用中" : "アカウント停止中"}</span>
                      {owner.status === "ACTIVE"
                        ? <button type="button" className={BUTTON} disabled={busy} onClick={() => void act(`accounts/${owner.hostAccountId}/suspend`, {}, "このアカウントを停止します。ログイン中の端末もすべて使えなくなります。よろしいですか。", (r) => r.changed === true ? "アカウントを停止しました。" : "すでに停止中です。")}>アカウントを停止</button>
                        : <button type="button" className={BUTTON} disabled={busy} onClick={() => void act(`accounts/${owner.hostAccountId}/reactivate`, {}, "このアカウントの停止を解除します。よろしいですか。", (r) => r.changed === true ? "アカウントの停止を解除しました。" : "すでに利用中です。")}>停止を解除</button>}
                    </li>
                  ))}
                </ul>
              </div>
              <div className="flex flex-wrap items-center gap-2 border-t border-line-strong pt-3">
                {suspended ? (
                  <button type="button" className={BUTTON} disabled={busy} onClick={() => void act(`${host.providerId}/clear-suspension`, {}, "ホストの運営停止を解除します。止めた体験は、オーナーが再開するまで公開も受付も戻りません。よろしいですか。", (r) => `停止を解除しました（${String(r.suspendedProducts ?? 0)}件の体験は、オーナーの再開を待ちます）。`)}>運営停止を解除</button>
                ) : (
                  <>
                    <label className="flex items-center gap-2 text-sm">理由
                      <select className={FIELD} value={reason} onChange={(event) => setReasons((current) => ({ ...current, [host.providerId]: event.target.value }))}>
                        {HOST_SUSPENSION_REASONS.map((item) => <option key={item.code} value={item.code}>{item.label}</option>)}
                      </select>
                    </label>
                    <button type="button" className={BUTTON} disabled={busy} onClick={() => void act(`${host.providerId}/suspend`, { reasonCode: reason }, `「${host.publicDisplayName ?? host.providerId}」を運営停止します。公開中のページと予約の受付をすべて止め、新しい公開と受付もできなくなります。よろしいですか。`, (r) => `運営停止しました（${String(r.suspendedProducts ?? 0)}件の体験を止めました）。`)}>運営停止</button>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
