"use client";

import { useState } from "react";
import type { GroupInquiryList, GroupInquiryRecord } from "@niho-experience/experience-store";
import { GROUP_INQUIRY_FIELDS, GROUP_INQUIRY_LIMITS, GROUP_INQUIRY_STATUSES, type GroupInquiryStatus } from "@niho-experience/experience-store/group-inquiry-fields";
import { INQUIRY_ENTRY_LABEL, INQUIRY_FIELD_LABEL, INQUIRY_KIND_LABEL, INQUIRY_STATUS_LABEL, inquiryAnswerLabel } from "@/lib/group-inquiry-copy";

const API = "/admin/api/inquiries";
const BUTTON = "min-h-11 rounded-full border border-line-strong px-4 font-extrabold hover:bg-sand disabled:opacity-50";
const FIELD = "mt-1 block min-h-11 w-full rounded-xl border border-line-strong bg-canvas px-3 font-normal";

type Filter = "ALL" | GroupInquiryStatus;
type Draft = { status: GroupInquiryStatus; assigneeLabel: string; nextDueOn: string; staffNote: string };

const draftOf = (record: GroupInquiryRecord): Draft => ({ status: record.status, assigneeLabel: record.assigneeLabel ?? "", nextDueOn: record.nextDueOn ?? "", staffNote: record.staffNote ?? "" });
const dateTime = (iso: string) => new Date(iso).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", dateStyle: "medium", timeStyle: "short" });

const MAIL_STATE: Record<string, string> = { PENDING: "送信待ち", SENDING: "送信中", SENT: "送信済み", FAILED: "送信できませんでした" };

/**
 * 団体・個別の相談の受付一覧 (#532, v0): what each person asked, what they were interested in, where they came from
 * as far as the page knew, and the office's hand-kept side: status, who at NIHO handles it, the next due date, a note.
 * An inquiry whose notice email did not go is marked apart from the accepted inquiry itself. There is no case page,
 * quote or concurrency guard in v0: the last save wins and its author is kept.
 */
export function AdminInquiries({ initial }: { initial: GroupInquiryList }) {
  const [data, setData] = useState(initial);
  const [filter, setFilter] = useState<Filter>("ALL");
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function reload(next: Filter = filter) {
    setLoading(true);
    try {
      const response = await fetch(next === "ALL" ? API : `${API}?status=${next}`, { cache: "no-store", credentials: "same-origin" });
      if (!response.ok) throw new Error("reload failed");
      setData(await response.json() as GroupInquiryList);
      setMessage(null);
    } catch { setMessage("一覧を読み込めませんでした。通信を確認してもう一度お試しください。"); }
    finally { setLoading(false); }
  }
  function choose(next: Filter) {
    setFilter(next);
    void reload(next);
  }
  function saved(record: GroupInquiryRecord) {
    // Replace the saved one in place; a filtered list keeps showing it until reloaded.
    setData((current) => ({ ...current, inquiries: current.inquiries.map((item) => item.id === record.id ? record : item) }));
    void reload();
  }

  const total = data.counts.NEW + data.counts.IN_PROGRESS + data.counts.DONE;
  return (
    <div className="mx-auto max-w-5xl space-y-5 px-4 py-8 md:px-7">
      <div>
        <h1 className="font-display text-2xl font-medium">相談</h1>
        <p className="mt-1 text-ink-soft">学校・法人・グループ・体験を載せたい方からの相談の受付です。期限を過ぎたものが先頭に並びます。個人情報を含むので、この画面の内容は外に貼らないでください。</p>
      </div>
      <nav aria-label="状態で絞り込む" className="flex flex-wrap gap-2">
        {(["ALL", ...GROUP_INQUIRY_STATUSES] as const).map((value) => (
          <button key={value} type="button" aria-pressed={filter === value} onClick={() => choose(value)} className={`min-h-11 rounded-full border px-4 font-extrabold ${filter === value ? "border-moss bg-leaf-pale text-moss" : "border-line-strong hover:bg-sand"}`}>
            {value === "ALL" ? "すべて" : INQUIRY_STATUS_LABEL[value]}（{value === "ALL" ? total : data.counts[value]}）
          </button>
        ))}
        <button type="button" disabled={loading} onClick={() => void reload()} className={BUTTON}>{loading ? "読み込み中…" : "再読み込み"}</button>
      </nav>
      {message ? <p role="alert" className="font-bold text-danger">{message}</p> : null}
      <ul className="space-y-4">
        {data.inquiries.map((record) => <InquiryCard key={`${record.id}:${record.updatedAt}`} record={record} today={data.today} onSaved={saved} />)}
        {data.inquiries.length === 0 ? <li className="rounded-2xl border border-line bg-canvas p-8 text-center text-ink-soft">該当する相談はありません</li> : null}
      </ul>
    </div>
  );
}

function InquiryCard({ record, today, onSaved }: { record: GroupInquiryRecord; today: string; onSaved: (record: GroupInquiryRecord) => void }) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(record));
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftOf(record));
  const overdue = record.status !== "DONE" && record.nextDueOn !== null && record.nextDueOn < today;
  const interest = [record.experienceTitle, record.hostName ? `${record.hostName}さん` : null].filter(Boolean).join(" / ");
  const source = [INQUIRY_ENTRY_LABEL[record.entry].ja, [record.utmSource, record.utmMedium, record.utmCampaign].filter(Boolean).join(" / ")].filter(Boolean).join("　");
  const answers = GROUP_INQUIRY_FIELDS[record.kind].flatMap((field) => record.details[field.key] ? [[INQUIRY_FIELD_LABEL[field.key]?.ja ?? field.key, inquiryAnswerLabel(field.key, record.details[field.key]!, "ja")] as const] : []);

  async function save() {
    if (saving || !dirty) return;
    setSaving(true); setNotice(null);
    try {
      const response = await fetch(API, {
        method: "POST", cache: "no-store", credentials: "same-origin", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "update", id: record.id, status: draft.status, assigneeLabel: draft.assigneeLabel.trim() === "" ? null : draft.assigneeLabel, nextDueOn: draft.nextDueOn === "" ? null : draft.nextDueOn, staffNote: draft.staffNote.trim() === "" ? null : draft.staffNote }),
      });
      if (!response.ok) throw new Error(String(response.status));
      const body = await response.json() as { inquiry: GroupInquiryRecord };
      setNotice({ tone: "ok", text: "保存しました。" });
      onSaved(body.inquiry);
    } catch { setNotice({ tone: "error", text: "保存できませんでした。入力はそのまま残しています。もう一度お試しください。" }); }
    finally { setSaving(false); }
  }

  return (
    <li className={`rounded-2xl border bg-canvas p-4 sm:p-5 ${overdue ? "border-danger" : "border-line"}`}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-mono text-sm">{record.inquiryRef}</span>
        <span className="rounded-full bg-sand px-2.5 py-0.5 text-sm font-bold">{INQUIRY_KIND_LABEL[record.kind].ja}</span>
        <span className="rounded-full border border-line-strong px-2.5 py-0.5 text-sm font-bold">{INQUIRY_STATUS_LABEL[record.status]}</span>
        {overdue ? <span className="rounded-full bg-danger px-2.5 py-0.5 text-sm font-bold text-white">期限を過ぎています</span> : null}
        <span className="ml-auto text-sm text-ink-soft">{dateTime(record.createdAt)}</span>
      </div>
      <h2 className="mt-2 text-lg font-extrabold">{record.contactName}</h2>
      <p className="text-sm"><a href={`mailto:${record.contactEmail}`} className="break-all underline">{record.contactEmail}</a>{record.locale === "en" ? "（英語のページから）" : ""}</p>
      <p className={`mt-2 text-sm font-bold ${record.staffMail === "FAILED" ? "text-danger" : "text-ink-soft"}`} role={record.staffMail === "FAILED" ? "alert" : undefined}>
        受付：完了　／　事務局への通知メール：{MAIL_STATE[record.staffMail] ?? record.staffMail}　／　相手への受付メール：{MAIL_STATE[record.senderMail] ?? record.senderMail}
        {record.staffMail === "FAILED" ? "（このメールは届いていません。この画面で確認してください）" : ""}
      </p>
      {interest ? <p className="mt-2 text-sm"><b>気になる体験・人：</b>{interest}</p> : null}
      <p className="text-sm text-ink-soft"><b>入口：</b>{source}</p>
      <p className="mt-3 whitespace-pre-wrap break-words rounded-xl bg-sand/60 p-3">{record.message}</p>
      {answers.length > 0 ? (
        <dl className="mt-3 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
          {answers.map(([label, value]) => <div key={label} className="contents"><dt className="font-extrabold">{label}</dt><dd className="break-words whitespace-pre-wrap">{value}</dd></div>)}
        </dl>
      ) : <p className="mt-3 text-sm text-ink-soft">任意の質問への回答はありません（未定のまま送られました）。</p>}
      <p className="mt-2 text-sm text-ink-soft">返信の目安として伝えた日：{record.replyByOn}</p>

      <form className="mt-4 grid gap-3 border-t border-line pt-4 sm:grid-cols-2" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <label className="font-bold">状態
          <select className={FIELD} value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value as GroupInquiryStatus })}>
            {GROUP_INQUIRY_STATUSES.map((value) => <option key={value} value={value}>{INQUIRY_STATUS_LABEL[value]}</option>)}
          </select>
        </label>
        <label className="font-bold">次の期限
          <input type="date" className={FIELD} value={draft.nextDueOn} onChange={(event) => setDraft({ ...draft, nextDueOn: event.target.value })} />
        </label>
        <label className="font-bold sm:col-span-2">事務局の担当（NIHO 側でこの相談を受け持つ人）
          <input className={FIELD} maxLength={GROUP_INQUIRY_LIMITS.assigneeMaxLength} value={draft.assigneeLabel} onChange={(event) => setDraft({ ...draft, assigneeLabel: event.target.value })} placeholder="例：高橋" />
        </label>
        <label className="font-bold sm:col-span-2">メモ（事務局の内部用。相手には見えません）
          <textarea className={`${FIELD} min-h-[96px] resize-y py-2`} rows={3} maxLength={GROUP_INQUIRY_LIMITS.staffNoteMaxLength} value={draft.staffNote} onChange={(event) => setDraft({ ...draft, staffNote: event.target.value })} />
        </label>
        <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
          <button type="submit" disabled={saving || !dirty} className={`${BUTTON} bg-ink text-white hover:bg-ink`}>{saving ? "保存中…" : "保存する"}</button>
          {record.updatedByActor ? <span className="text-sm text-ink-soft">最終更新：{dateTime(record.updatedAt)}</span> : null}
          {notice ? <p role={notice.tone === "error" ? "alert" : "status"} className={`text-sm font-bold ${notice.tone === "error" ? "text-danger" : ""}`}>{notice.text}</p> : null}
        </div>
      </form>
    </li>
  );
}
