"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ExperienceProviderMember, ExperienceProviderResolveMemberResponse } from "@niho-experience/api-client/experience-provider-operations";
import type { HostProviderRole } from "@/lib/host/providers";
import { FieldSection } from "./fields";
import { consoleButtonClass } from "./host-ui";

export function HostOperatingTeamPanel({ providerId, role, enabled }: { providerId: string; role: HostProviderRole | null; enabled: boolean }) {
  const [members, setMembers] = useState<ExperienceProviderMember[]>([]); const [email, setEmail] = useState("");
  const [candidate, setCandidate] = useState<ExperienceProviderResolveMemberResponse["candidate"] | null>(null);
  const [candidateEmail, setCandidateEmail] = useState(""); const [busy, setBusy] = useState(""); const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  const [ended, setEnded] = useState(false);
  const lookup = useRef(0); const root = `/host/api/provider-operations/${encodeURIComponent(providerId)}/members`;
  const load = useCallback(async () => {
    if (role !== "OWNER" || !enabled) return;
    const response = await fetch(root, { cache: "no-store" });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403 || response.status === 404) { setMembers([]); setCandidate(null); setEnded(true); }
      throw new Error(response.status === 401 ? "ログインの有効期限が切れました。" : response.status === 404 || response.status === 403 ? "チームを管理する権限が終了しています。" : "運営チームを読み込めませんでした。");
    }
    const value = await response.json() as { members: ExperienceProviderMember[] }; setMembers(value.members);
  }, [enabled, role, root]);
  useEffect(() => {
    const version = ++lookup.current;
    let active = true;
    queueMicrotask(() => { if (active) void load().catch((reason) => { if (active && version === lookup.current) setError(reason instanceof Error ? reason.message : "運営チームを読み込めませんでした。"); }); });
    return () => { active = false; lookup.current += 1; };
  }, [load, providerId]);

  if (role === "COHOST") return <FieldSection id="settings-team" title="運営チーム"><div className="p-4"><p className="font-extrabold">あなたはサブホストです</p><p className="mt-1 text-sm text-ink-soft">この提供者のすべての体験・開催条件・予約対応・予約者への返信を担当できます。販売者名義、Stripe・売上受取、法的同意、メンバー管理はオーナーが行います。</p></div></FieldSection>;
  if (role !== "OWNER") return null;
  if (!enabled) return <FieldSection id="settings-team" title="運営チーム"><p className="p-4 text-ink-soft">サブホスト管理は現在利用できません。</p></FieldSection>;

  async function resolve(event: React.FormEvent) {
    event.preventDefault(); const submitted = email.trim(); const version = ++lookup.current; setBusy("resolve"); setError(""); setNotice(""); setCandidate(null); setCandidateEmail("");
    try { const response = await fetch(`${root}/resolve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: submitted }) }); if (version !== lookup.current) return; if (!response.ok) { if (response.status === 401 || response.status === 403) setEnded(true); throw new Error(response.status === 404 ? "一致する登録済みNIHOアカウントが見つかりません。" : response.status === 401 ? "ログインの有効期限が切れました。" : response.status === 403 ? "メンバーを管理する権限が終了しています。" : "アカウントを確認できませんでした。"); } const value = await response.json() as ExperienceProviderResolveMemberResponse; if (version !== lookup.current || submitted !== email.trim()) return; setCandidate(value.candidate); setCandidateEmail(submitted); }
    catch (reason) { if (version === lookup.current) setError(reason instanceof Error ? reason.message : "アカウントを確認できませんでした。"); } finally { if (version === lookup.current) setBusy(""); }
  }
  async function add() {
    if (!candidate || candidateEmail !== email.trim() || busy) return; setBusy(`add:${candidate.userId}`); setError(""); setNotice("");
    if (!window.confirm(`${candidate.displayName}をサブホストにしますか？ この提供者のすべての体験・予約・予約者情報を継続して扱えるようになります。`)) { setBusy(""); return; }
    try { const response = await fetch(`${root}/${encodeURIComponent(candidate.userId)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ role: "COHOST" }) }); if (!response.ok) { if (response.status === 401 || response.status === 403 || response.status === 404) setEnded(true); throw new Error(response.status === 401 ? "ログインの有効期限が切れました。" : response.status === 404 || response.status === 403 ? "権限または候補の状態が変わりました。現在のチームを確認してください。" : "サブホストを追加できませんでした。"); } await load(); setCandidate(null); setCandidateEmail(""); setEmail(""); setNotice("現在の運営チームにサブホストを追加しました。"); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "サブホストを追加できませんでした。"); } finally { setBusy(""); }
  }
  async function remove(member: ExperienceProviderMember) {
    if (member.role !== "COHOST" || busy || !window.confirm(`${member.displayName}をサブホストから外しますか？ この提供者の体験・予約・予約者情報へアクセスできなくなります。`)) return;
    setBusy(`remove:${member.userId}`); setError(""); setNotice("");
    try { const response = await fetch(`${root}/${encodeURIComponent(member.userId)}`, { method: "DELETE" }); if (!response.ok && response.status !== 204) { if (response.status === 401 || response.status === 403 || response.status === 404) setEnded(true); throw new Error(response.status === 401 ? "ログインの有効期限が切れました。" : response.status === 404 || response.status === 403 ? "権限またはメンバーの状態が変わりました。現在のチームを確認してください。" : "サブホストを外せませんでした。"); } await load(); setNotice("現在の運営チームからサブホストを外しました。"); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "サブホストを外せませんでした。"); } finally { setBusy(""); }
  }
  if (ended) return <FieldSection id="settings-team" title="運営チーム"><p role="alert" className="m-4 rounded-xl bg-danger-pale p-3 text-danger">{error || "チームを管理する権限が終了しています。"}</p></FieldSection>;
  return <FieldSection id="settings-team" title="運営チーム"><div className="space-y-4 p-4"><div><p className="font-extrabold">この提供者の運営メンバー</p><p className="mt-1 text-sm text-ink-soft">サブホストの権限はこの提供者の全体に適用され、すべての体験と予約を操作できます。販売者・法的同意・Stripe・売上受取・メンバー管理はオーナー専用です。</p></div>{error ? <p role="alert" className="rounded-xl bg-danger-pale p-3 text-danger">{error}</p> : null}{notice ? <p role="status" className="rounded-xl bg-leaf-pale p-3 text-moss">{notice}</p> : null}<ul className="space-y-2">{members.map((member) => <li key={member.userId} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-sand p-3"><span><strong>{member.displayName}</strong><span className="ml-2 text-xs text-muted">{member.role === "OWNER" ? "オーナー" : member.role === "COHOST" ? "サブホスト" : "編集者"}</span></span>{member.role === "COHOST" ? <button type="button" disabled={Boolean(busy)} onClick={() => void remove(member)} className={consoleButtonClass("secondary", "sm")}>外す</button> : null}</li>)}</ul><form onSubmit={resolve} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]"><label className="font-extrabold">登録済みNIHOアカウントのメールアドレス<input type="email" required maxLength={320} autoComplete="off" value={email} onChange={(event) => { lookup.current += 1; setBusy(""); setEmail(event.target.value); setCandidate(null); setCandidateEmail(""); setError(""); }} className="mt-1 min-h-10 w-full rounded-xl border border-line-strong px-3" /></label><button disabled={Boolean(busy)} className={`${consoleButtonClass("secondary")} self-end`}>{busy === "resolve" ? "確認中…" : "アカウントを確認"}</button></form>{candidate ? <div className="rounded-xl border border-line-strong p-4"><p className="font-extrabold">{candidate.displayName}</p><p className="mt-1 text-sm text-ink-soft">この方をサブホストにすると、この提供者のすべての体験・開催条件・予約、予約者情報と返信を継続して担当できます。</p><button type="button" disabled={Boolean(busy) || candidateEmail !== email.trim()} onClick={() => void add()} className={`${consoleButtonClass("primary")} mt-3`}>{busy.startsWith("add:") ? "追加中…" : "範囲を確認してサブホストにする"}</button></div> : null}<p className="text-xs text-muted">招待メールは送りません。既に登録済みのアカウントだけを完全一致で確認します。</p></div></FieldSection>;
}
