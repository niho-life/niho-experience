"use client";

import { useState } from "react";
import type { AdminPeopleListingRow } from "@niho-experience/experience-store";
import { MemberProfileEditor } from "@/components/host/MemberProfileEditor";
import { consoleButtonClass } from "@/components/host/host-ui";

const API = "/admin/api/people";
const FIELD = "mt-1 block min-h-11 w-full rounded-xl border border-line-strong bg-canvas px-3 font-normal";

export function AdminPeople({ initial }: { initial: AdminPeopleListingRow[] }) {
  const [rows, setRows] = useState(initial);
  const [message, setMessage] = useState<string | null>(null);

  async function reload() {
    try {
      const response = await fetch(API, { cache: "no-store" });
      if (!response.ok) throw new Error("reload failed");
      setRows(((await response.json()) as { people: AdminPeopleListingRow[] }).people);
      setMessage(null);
    } catch { setMessage("一覧を読み込めませんでした。通信を確認して再度お試しください。"); }
  }

  return <div className="mx-auto max-w-5xl space-y-5 px-4 py-8 md:px-7">
    <div>
      <h1 className="font-display text-2xl font-medium">街の人</h1>
      <p className="mt-1 text-ink-soft">日本語サイトの「街の人」に載せるメンバーと、表示する順番を設定します。掲載設定と本人プロフィールの公開がそろうと表示されます。</p>
    </div>
    <button type="button" onClick={() => void reload()} className={consoleButtonClass("secondary", "sm")}>再読み込み</button>
    {message ? <p role="alert" className="font-bold text-danger">{message}</p> : null}
    <ul className="space-y-4">
      {rows.map((row) => <PersonCard key={`${row.key}:${row.listing?.version ?? 0}`} row={row} candidates={rows.filter((candidate) => candidate.providerId === row.providerId && !candidate.listing && candidate.memberRole !== null)} onChanged={setRows} reload={reload} />)}
      {rows.length === 0 ? <li className="rounded-2xl border border-line bg-canvas p-8 text-center text-ink-soft">提供者のオーナー・共同ホストはまだいません。</li> : null}
    </ul>
  </div>;
}

function PersonCard({ row, candidates, onChanged, reload }: {
  row: AdminPeopleListingRow;
  candidates: AdminPeopleListingRow[];
  onChanged: (rows: AdminPeopleListingRow[]) => void;
  reload: () => Promise<void>;
}) {
  const [slug, setSlug] = useState(row.listing?.slug ?? "");
  const [sortOrder, setSortOrder] = useState(String(row.listing?.sortOrder ?? 100));
  const [assignedMember, setAssignedMember] = useState("");
  const [editingProfile, setEditingProfile] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const memberId = row.memberId ?? assignedMember;
  const displayName = row.name ?? row.legacyName ?? row.providerName;
  const dirty = !row.listing || slug !== row.listing.slug || Number(sortOrder) !== row.listing.sortOrder || Boolean(assignedMember);

  async function send(method: "PUT" | "DELETE") {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const body = method === "PUT"
        ? { listingId: row.listing?.id ?? null, providerId: row.providerId, memberId: memberId || null, expectedVersion: row.listing?.version ?? null, listing: { slug: slug.trim(), sortOrder: Number(sortOrder) } }
        : { listingId: row.listing?.id, expectedVersion: row.listing?.version };
      const response = await fetch(API, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!response.ok) {
        setError(response.status === 409 ? "内容が変更されたか、URL が重複しています。再読み込みして確認してください。" : "掲載設定を保存できませんでした。入力と権限を確認してください。");
        return;
      }
      onChanged(((await response.json()) as { people: AdminPeopleListingRow[] }).people);
    } catch { setError("変更結果を確認できませんでした。再読み込みして確認してください。"); }
    finally { setBusy(false); }
  }

  return <li className="space-y-4 rounded-2xl border border-line bg-canvas p-4 sm:p-5">
    <div>
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="text-lg font-extrabold">{displayName}</h2>
        <span className="text-sm font-bold text-ink-soft">{row.visible ? "掲載中" : row.listing ? "掲載先を登録済み・非表示" : "掲載先未登録"}</span>
      </div>
      <p className="break-all text-sm text-muted">{row.providerName}{row.memberId ? ` · ${row.memberRole === "OWNER" ? "オーナー" : row.memberRole === "COHOST" ? "共同ホスト" : "現役メンバー外"} · ${row.memberId}` : " · メンバー未設定"}</p>
    </div>
    <form onSubmit={(event) => { event.preventDefault(); void send("PUT"); }} className="grid gap-3 sm:grid-cols-2">
      {!row.memberId && candidates.length ? <label className="text-sm font-bold sm:col-span-2">既存の紹介を引き継ぐメンバー
        <select className={FIELD} value={assignedMember} onChange={(event) => setAssignedMember(event.target.value)}>
          <option value="">選択してください</option>
          {candidates.map((candidate) => <option key={candidate.key} value={candidate.memberId!}>{candidate.name ?? candidate.memberId}</option>)}
        </select>
      </label> : null}
      <label className="text-sm font-bold">スラッグ（URL の一部）<input className={FIELD} value={slug} onChange={(event) => setSlug(event.target.value)} pattern="[a-z0-9]+(-[a-z0-9]+)*" minLength={2} maxLength={60} required /></label>
      <label className="text-sm font-bold">並び順（小さいほど先）<input className={FIELD} type="number" min={0} max={9999} value={sortOrder} onChange={(event) => setSortOrder(event.target.value)} required /></label>
      <div className="flex flex-wrap gap-2 sm:col-span-2">
        <button type="submit" className={consoleButtonClass("primary", "sm")} disabled={busy || !dirty || (row.memberId !== null && row.memberRole === null)}>{row.listing ? "掲載設定を保存する" : "掲載先を登録する"}</button>
        {row.listing ? <button type="button" className={consoleButtonClass("secondary", "sm")} disabled={busy} onClick={() => { if (window.confirm("この人を「街の人」の掲載対象から外しますか？")) void send("DELETE"); }}>街の人から外す</button> : null}
      </div>
      {error ? <p role="alert" className="text-sm text-danger sm:col-span-2">{error}</p> : null}
    </form>
    {row.memberId && row.memberRole ? <details className="border-t border-line pt-3" onToggle={(event) => setEditingProfile(event.currentTarget.open)}>
      <summary className="cursor-pointer text-sm font-extrabold">本人プロフィールの代理入力・公開</summary>
      {editingProfile ? <div className="pt-3"><MemberProfileEditor admin api={`/admin/api/member-profiles/${encodeURIComponent(row.providerId)}/${encodeURIComponent(row.memberId)}`} changed={() => { void reload(); }} /></div> : null}
    </details> : null}
  </li>;
}
