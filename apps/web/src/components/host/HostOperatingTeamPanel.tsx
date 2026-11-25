"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ExperienceProviderMember, ExperienceProviderResolveMemberResponse } from "@niho-experience/api-client/experience-provider-operations";
import type { HostProviderRole } from "@/lib/host/providers";
import { parseTeamInvitationCreated, parseTeamInvitations, parseTeamMutation, parseTeamResolveResult, parseTeamSnapshot, teamMutationMatchesCommand, type TeamInvitationView } from "@/lib/host/team-contract";
import { FieldSection } from "./fields";
import { consoleButtonClass } from "./host-ui";
import { HostTeamAsyncGate } from "./host-team-async";

const REQUEST_TIMEOUT_MS = 15_000;
const teamError = (reason: unknown, fallback: string) => reason instanceof Error && reason.name === "Error" ? reason.message : fallback;

export type HostTeamMode = "native" | "legacy" | "off";

/** The date an invitation runs out, as the host reads it (Japan time). */
const dayJa = (utc: string) => new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "numeric", day: "numeric" }).format(new Date(utc));
const INVITATION_STATE_LABEL: Record<TeamInvitationView["state"], string> = { QUEUED: "送信待ち", SENT: "送信済み", OPENED: "相手が開きました" };

/** `invitationsEnabled` (EXPERIENCE_HOST_TEAM_INVITATIONS_ENABLED, #636): the OWNER invites by email instead of finding an account by address. */
export function HostOperatingTeamPanel({ providerId, role, mode, invitationsEnabled = false }: { providerId: string; role: HostProviderRole | null; mode: HostTeamMode; invitationsEnabled?: boolean }) {
  if (mode === "native") return <NativeTeamPanel key={`${providerId}:${role ?? "none"}:${invitationsEnabled ? "invite" : "resolve"}`} providerId={providerId} role={role} invitationsEnabled={invitationsEnabled} />;
  return <LegacyTeamPanel providerId={providerId} role={role} enabled={mode === "legacy"} />;
}

type NativeMember = { readonly hostAccountId: string; readonly role: "OWNER" | "COHOST" | "EDITOR" | "VIEWER"; readonly label: string };
type PendingCommand = { readonly operation: "add" | "remove"; readonly target: string; readonly commandId: string; readonly expectedRevision: number };

function NativeTeamPanel({ providerId, role, invitationsEnabled }: { providerId: string; role: HostProviderRole | null; invitationsEnabled: boolean }) {
  const [members, setMembers] = useState<readonly NativeMember[]>([]); const [revision, setRevision] = useState(0);
  const [email, setEmail] = useState(""); const [candidate, setCandidate] = useState<{ hostAccountId: string; label: string } | null>(null);
  const [candidateEmail, setCandidateEmail] = useState(""); const [pending, setPending] = useState<PendingCommand | null>(null);
  const [busy, setBusy] = useState(""); const [error, setError] = useState(""); const [notice, setNotice] = useState(""); const [ended, setEnded] = useState(false);
  const [invitations, setInvitations] = useState<readonly TeamInvitationView[]>([]); const [inviteEmail, setInviteEmail] = useState("");
  const gate = useRef(new HostTeamAsyncGate());
  const controllers = useRef(new Set<AbortController>()); const root = `/host/api/team/${encodeURIComponent(providerId)}/members`; const invitationsRoot = `/host/api/team/${encodeURIComponent(providerId)}/invitations`; const scopeKey = `${providerId}:${role ?? "none"}`;

  const clearPrivate = useCallback(() => { setMembers([]); setCandidate(null); setCandidateEmail(""); setEmail(""); setPending(null); setBusy(""); setInvitations([]); setInviteEmail(""); }, []);
  const endAccess = useCallback((message: string) => {
    gate.current.deactivate();
    for (const controller of controllers.current) controller.abort(); controllers.current.clear();
    clearPrivate(); setNotice(""); setError(message); setEnded(true);
  }, [clearPrivate]);
  const load = useCallback(async (expectedScope = scopeKey) => {
    const token = gate.current.begin("list"); const controller = new AbortController(); controllers.current.add(controller); const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(root, { cache: "no-store", signal: controller.signal });
      if (!gate.current.current(token) || token.scope !== expectedScope) return false;
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) endAccess(response.status === 401 ? "ログインの有効期限が切れました。" : "チームを管理する権限が終了しています。");
        throw new Error(response.status === 401 ? "ログインの有効期限が切れました。" : response.status === 403 ? "チームを管理する権限が終了しています。" : "運営チームを読み込めませんでした。");
      }
      const value: unknown = await response.json();
      if (!gate.current.current(token) || token.scope !== expectedScope) return false;
      const parsed = parseTeamSnapshot(value);
      if (!parsed) throw new Error("運営チームの応答を確認できませんでした。再読込してください。");
      setMembers(parsed.members); setRevision(parsed.teamRevision); return true;
    } finally { window.clearTimeout(timeout); controllers.current.delete(controller); }
  }, [endAccess, root, scopeKey]);

  const loadInvitations = useCallback(async (expectedScope = scopeKey) => {
    const token = gate.current.begin("invitations"); const controller = new AbortController(); controllers.current.add(controller); const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(invitationsRoot, { cache: "no-store", signal: controller.signal });
      if (!gate.current.current(token) || token.scope !== expectedScope) return false;
      if (!response.ok) {
        if (response.status === 401 || response.status === 403 || response.status === 404) endAccess(response.status === 401 ? "ログインの有効期限が切れました。" : "チームを管理する権限が終了しています。");
        throw new Error(response.status === 401 ? "ログインの有効期限が切れました。" : response.status === 403 || response.status === 404 ? "チームを管理する権限が終了しています。" : "招待中の一覧を読み込めませんでした。");
      }
      const value: unknown = await response.json();
      if (!gate.current.current(token) || token.scope !== expectedScope) return false;
      const parsed = parseTeamInvitations(value);
      if (!parsed) throw new Error("招待中の一覧の応答を確認できませんでした。再読込してください。");
      setInvitations(parsed.invitations); return true;
    } finally { window.clearTimeout(timeout); controllers.current.delete(controller); }
  }, [endAccess, invitationsRoot, scopeKey]);

  useEffect(() => {
    const requests = gate.current;
    const activeControllers = controllers.current;
    requests.activate(scopeKey);
    if (role === "OWNER") void load(scopeKey).catch((reason) => { if (requests.active(scopeKey)) setError(teamError(reason, "運営チームを読み込めませんでした。再読込してください。")); });
    if (role === "OWNER" && invitationsEnabled) void loadInvitations(scopeKey).catch((reason) => { if (requests.active(scopeKey)) setError(teamError(reason, "招待中の一覧を読み込めませんでした。再読込してください。")); });
    return () => {
      requests.deactivate();
      for (const controller of activeControllers) controller.abort(); activeControllers.clear();
    };
  }, [invitationsEnabled, load, loadInvitations, role, scopeKey]);

  if (role === "COHOST") return <FieldSection id="settings-team" title="運営チーム"><div className="p-4"><p className="font-extrabold">あなたは共同ホストです</p><p className="mt-1 text-sm text-ink-soft">開催枠、予約の参照、予約者への返信を担当できます。本文・料金・販売者情報・受取口座・売上・手数料同意・公開と停止・取消と返金・チーム・通知設定はオーナー専用です。</p></div></FieldSection>;
  if (role !== "OWNER") return null;

  async function resolve(event: React.FormEvent) {
    event.preventDefault(); if (pending) return;
    const submitted = email.trim(); const token = gate.current.begin("resolve"); const expectedScope = scopeKey; const controller = new AbortController(); controllers.current.add(controller); const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    setBusy("resolve"); setError(""); setNotice(""); setCandidate(null); setCandidateEmail("");
    try {
      const response = await fetch(`${root}/resolve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: submitted }), signal: controller.signal });
      if (!gate.current.current(token) || token.scope !== expectedScope) return;
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) endAccess(response.status === 401 ? "ログインの有効期限が切れました。" : "メンバーを管理する権限が終了しています。");
        throw new Error(response.status === 429 ? "確認回数の上限に達しました。しばらく待ってから再試行してください。" : response.status === 401 ? "ログインの有効期限が切れました。" : response.status === 403 ? "メンバーを管理する権限が終了しています。" : "アカウントを確認できませんでした。");
      }
      const value: unknown = await response.json();
      if (!gate.current.current(token) || token.scope !== expectedScope) return;
      const parsed = parseTeamResolveResult(value);
      if (!parsed) throw new Error("確認結果の応答を確認できませんでした。");
      setRevision(parsed.teamRevision); setCandidate(parsed.candidate); setCandidateEmail(submitted);
      if (!parsed.candidate) setError("この宛先の人は、まだ登録されていません。NIHO に登録を依頼してください。");
    } catch (reason) { if (gate.current.current(token)) setError(teamError(reason, "アカウントを確認できませんでした。もう一度お試しください。")); }
    finally { window.clearTimeout(timeout); controllers.current.delete(controller); if (gate.current.current(token)) setBusy((value) => value === "resolve" ? "" : value); }
  }

  async function sendCommand(command: PendingCommand) {
    const token = gate.current.begin("command"); const expectedScope = scopeKey; const controller = new AbortController(); controllers.current.add(controller); const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    setPending(command); setBusy(`${command.operation}:${command.target}`); setError(""); setNotice("");
    try {
      const response = await fetch(`${root}/${encodeURIComponent(command.target)}`, { method: command.operation === "add" ? "PUT" : "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ commandId: command.commandId, expectedRevision: command.expectedRevision }), signal: controller.signal });
      if (!gate.current.current(token) || token.scope !== expectedScope) return;
      if (response.status === 401 || response.status === 403) { endAccess("チームを管理する権限が終了しています。"); throw new Error("チームを管理する権限が終了しています。"); }
      if (response.status === 409) {
        setPending(null);
        await load(expectedScope);
        if (!gate.current.current(token) || token.scope !== expectedScope) return;
        throw new Error("チームが変更されました。再読込した内容を確認してください。");
      }
      if (response.status === 400 || response.status === 404) {
        setPending(null);
        throw new Error(response.status === 404 ? "対象アカウントの状態が変わりました。" : "操作の内容が無効です。画面を再読込してください。");
      }
      if (!response.ok) throw new Error("変更結果を確認できません。同じ操作を再送してください。");
      const value: unknown = await response.json();
      if (!gate.current.current(token) || token.scope !== expectedScope) return;
      const parsed = parseTeamMutation(value);
      if (!parsed || !teamMutationMatchesCommand(parsed, command)) {
        throw new Error("変更結果を確認できません。同じ操作を再送してください。");
      }
      gate.current.invalidate("list"); gate.current.invalidate("resolve");
      setMembers(parsed.members); setRevision(parsed.teamRevision); setPending(null); setCandidate(null); setCandidateEmail(""); setEmail("");
      setNotice(command.operation === "add" ? "共同ホストを追加しました。" : "共同ホストを外しました。");
    } catch (reason) { if (gate.current.current(token)) setError(teamError(reason, "変更結果を確認できません。同じ操作を再送してください。")); }
    finally { window.clearTimeout(timeout); controllers.current.delete(controller); if (gate.current.current(token)) setBusy(""); }
  }

  function add() {
    if (!candidate || candidateEmail !== email.trim() || pending || busy) return;
    if (!window.confirm("共同ホストは開催枠・予約者情報・返信を扱えます。本文・料金・金融・公開・取消返金・設定は扱えません。追加しますか？")) return;
    void sendCommand({ operation: "add", target: candidate.hostAccountId, commandId: crypto.randomUUID(), expectedRevision: revision });
  }
  function remove(member: NativeMember) {
    if (member.role !== "COHOST" || pending || busy || !window.confirm("この共同ホストの当該提供者へのアクセスを外しますか？")) return;
    void sendCommand({ operation: "remove", target: member.hostAccountId, commandId: crypto.randomUUID(), expectedRevision: revision });
  }

  async function invite(event: React.FormEvent) {
    event.preventDefault(); if (busy || pending) return;
    const submitted = inviteEmail.trim(); if (submitted === "") return;
    if (!window.confirm("共同ホストは開催枠・予約者情報・返信を扱えます。本文・料金・金融・公開・取消返金・設定は扱えません。招待しますか？")) return;
    const token = gate.current.begin("invitations"); const expectedScope = scopeKey; const controller = new AbortController(); controllers.current.add(controller); const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    setBusy("invite"); setError(""); setNotice("");
    try {
      const response = await fetch(invitationsRoot, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: submitted }), signal: controller.signal });
      if (!gate.current.current(token) || token.scope !== expectedScope) return;
      if (response.status === 401 || response.status === 403 || response.status === 404) { endAccess(response.status === 401 ? "ログインの有効期限が切れました。" : "メンバーを管理する権限が終了しています。"); return; }
      if (response.status === 429) throw new Error("確認回数の上限に達しました。しばらく待ってから再試行してください。");
      if (response.status === 409) {
        const value: unknown = await response.json().catch(() => null);
        if (!gate.current.current(token) || token.scope !== expectedScope) return;
        const reason = typeof value === "object" && value !== null && "error" in value ? (value as { error: unknown }).error : null;
        throw new Error(reason === "already_member" ? "この宛先の人は、すでにメンバーです。" : reason === "too_many_open" ? "招待中が多すぎます。使わない招待を取り消してから、もう一度お試しください。" : "招待を送れませんでした。もう一度お試しください。");
      }
      if (response.status === 400) throw new Error("メールアドレスの形式を確認してください。");
      if (response.status !== 201) throw new Error("招待を送れませんでした。もう一度お試しください。");
      const value: unknown = await response.json();
      if (!gate.current.current(token) || token.scope !== expectedScope) return;
      const created = parseTeamInvitationCreated(value);
      if (!created) throw new Error("招待の結果を確認できませんでした。招待中の一覧を再読込してください。");
      // The same address again replaces the earlier invitation, so the list shows one for it.
      setInvitations((current) => [...current.filter((item) => item.email.toLowerCase() !== created.invitation.email.toLowerCase()), created.invitation]);
      setInviteEmail(""); setNotice("招待を送りました。相手が NIHO アカウントでログインすると参加します。");
    } catch (reason) { if (gate.current.current(token)) setError(teamError(reason, "招待を送れませんでした。もう一度お試しください。")); }
    finally { window.clearTimeout(timeout); controllers.current.delete(controller); if (gate.current.current(token)) setBusy((value) => value === "invite" ? "" : value); }
  }
  async function revokeInvitation(item: TeamInvitationView) {
    if (busy || pending || !window.confirm("この招待を取り消しますか？")) return;
    const token = gate.current.begin("invitations"); const expectedScope = scopeKey; const controller = new AbortController(); controllers.current.add(controller); const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    setBusy(`revoke:${item.id}`); setError(""); setNotice("");
    try {
      const response = await fetch(`${invitationsRoot}/${encodeURIComponent(item.id)}`, { method: "DELETE", signal: controller.signal });
      if (!gate.current.current(token) || token.scope !== expectedScope) return;
      if (response.status === 401 || response.status === 403) { endAccess(response.status === 401 ? "ログインの有効期限が切れました。" : "メンバーを管理する権限が終了しています。"); return; }
      if (response.status === 404) {
        // Used, taken back or run out meanwhile: show what the team and the list are now.
        setBusy(""); await Promise.all([load(expectedScope), loadInvitations(expectedScope)]);
        throw new Error("この招待は、すでに使われたか、取り消されています。");
      }
      if (response.status !== 204) throw new Error("招待を取り消せませんでした。もう一度お試しください。");
      setInvitations((current) => current.filter((candidate) => candidate.id !== item.id)); setNotice("招待を取り消しました。");
    } catch (reason) { setError(teamError(reason, "招待を取り消せませんでした。もう一度お試しください。")); }
    finally { window.clearTimeout(timeout); controllers.current.delete(controller); setBusy((value) => value === `revoke:${item.id}` ? "" : value); }
  }
  const inviteSection = (
    <div className="space-y-4">
      <form onSubmit={invite} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
        <label className="font-extrabold">相手のメールアドレス<input type="email" required maxLength={254} autoComplete="off" value={inviteEmail} disabled={pending !== null} onChange={(event) => { setInviteEmail(event.target.value); setError(""); }} className="mt-1 min-h-10 w-full rounded-xl border border-line-strong px-3" /></label>
        <button disabled={Boolean(busy) || pending !== null} className={`${consoleButtonClass("secondary")} self-end`}>{busy === "invite" ? "送信中…" : "招待を送る"}</button>
      </form>
      <p className="text-xs text-muted">相手は、招待メールのリンクから NIHO アカウントでログインすると参加できます。リンクは7日間、1回だけ使えます。</p>
      {invitations.length > 0 ? (
        <div>
          <p className="font-extrabold">招待中</p>
          <ul className="mt-2 space-y-2">
            {invitations.map((item) => (
              <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-sand p-3">
                <span><strong>{item.email}</strong><span className="ml-2 text-xs text-muted">{INVITATION_STATE_LABEL[item.state]}</span><span className="ml-2 text-xs text-muted">{dayJa(item.expiresAt)} まで</span></span>
                <button type="button" disabled={Boolean(busy) || pending !== null} onClick={() => void revokeInvitation(item)} className={consoleButtonClass("secondary", "sm")}>取り消す</button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );

  if (ended) return <FieldSection id="settings-team" title="運営チーム"><p role="alert" className="m-4 rounded-xl bg-danger-pale p-3 text-danger">{error || "チームを管理する権限が終了しています。"}</p></FieldSection>;
  return <FieldSection id="settings-team" title="運営チーム"><div className="space-y-4 p-4"><div><p className="font-extrabold">この提供者の運営メンバー</p><p className="mt-1 text-sm text-ink-soft">共同ホストは開催枠・予約の参照・予約者への返信を担当します。本文・料金・販売者情報・受取口座・売上・手数料同意・公開/停止・取消返金・チーム・通知はオーナー専用です。編集者と商品限定オペレーターの権限は変わりません。</p></div>{error ? <p role="alert" className="rounded-xl bg-danger-pale p-3 text-danger">{error}</p> : null}{notice ? <p role="status" className="rounded-xl bg-leaf-pale p-3 text-moss">{notice}</p> : null}{pending ? <p className="rounded-xl bg-warn-pale p-3 text-sm">結果が不明です。他の操作は行わず、同じ操作だけを再送してください。<button type="button" disabled={Boolean(busy)} onClick={() => void sendCommand(pending)} className={`${consoleButtonClass("secondary", "sm")} ml-2`}>同じ操作を再送</button></p> : null}<ul className="space-y-2">{members.map((member) => <li key={member.hostAccountId} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-sand p-3"><span><strong>{member.label}</strong><span className="ml-2 text-xs text-muted">{member.role === "OWNER" ? "オーナー" : member.role === "COHOST" ? "共同ホスト" : member.role === "EDITOR" ? "編集者" : "閲覧者"}</span></span>{member.role === "COHOST" ? <button type="button" disabled={Boolean(busy) || pending !== null} onClick={() => remove(member)} className={consoleButtonClass("secondary", "sm")}>外す</button> : null}</li>)}</ul>{invitationsEnabled ? <><p className="font-extrabold">メンバーを招待</p>{inviteSection}</> : <><form onSubmit={resolve} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]"><label className="font-extrabold">相手のメールアドレス<input type="email" required maxLength={254} autoComplete="off" value={email} disabled={pending !== null} onChange={(event) => { gate.current.invalidate("resolve"); if (busy === "resolve") setBusy(""); setEmail(event.target.value); setCandidate(null); setCandidateEmail(""); setError(""); }} className="mt-1 min-h-10 w-full rounded-xl border border-line-strong px-3" /></label><button disabled={Boolean(busy) || pending !== null} className={`${consoleButtonClass("secondary")} self-end`}>{busy === "resolve" ? "確認中…" : "アカウントを確認"}</button></form>{candidate ? <div className="rounded-xl border border-line-strong p-4"><p className="font-extrabold">{candidate.label}</p><p className="mt-1 text-sm text-ink-soft">確認したアドレス: {candidateEmail}</p><p className="mt-1 text-sm text-ink-soft">共同ホストとして、開催枠・予約者情報・返信を担当できるようにします。</p><button type="button" disabled={Boolean(busy) || pending !== null || candidateEmail !== email.trim()} onClick={add} className={`${consoleButtonClass("primary")} mt-3`}>範囲を確認して共同ホストにする</button></div> : null}<p className="text-xs text-muted">追加できるのは、NIHO への登録が済んでいる人です。この画面からメールは送られません（確認は1時間に12回まで）。</p></>}</div></FieldSection>;
}

function LegacyTeamPanel({ providerId, role, enabled }: { providerId: string; role: HostProviderRole | null; enabled: boolean }) {
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
