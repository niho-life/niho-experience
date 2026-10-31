"use client";

import { useState, type ReactNode } from "react";
import type { SupportQueue, SupportQueueBooking } from "@niho-experience/experience-store";

/*
 * サイト予約の取消・返金 (#285 slice 7, docs/guest-booking.md「取消と返金（第7段）」): what NIHO support has to look at
 * among the bookings made on this site, and its actions. Each action is confirmed on the row first and sent with a UUID
 * kept until an answer comes back, so a retry after a lost answer is the same action. After every answer the list is
 * read again. Partial refunds keep NIHO's fee (support enters the amount); full refunds give it back.
 */

const API = "/admin/api/site-bookings";
const BUTTON = "min-h-10 rounded-full border border-line-strong px-4 font-extrabold hover:bg-sand disabled:opacity-50";
const DANGER = "min-h-10 rounded-full border border-danger/40 px-4 font-extrabold text-danger hover:bg-danger-pale disabled:opacity-50";
const FIELD = "min-h-10 w-full rounded-xl border border-line-strong bg-canvas px-3";
const REASONS = [
  { value: "GUEST_REQUEST", label: "予約者からの依頼" },
  { value: "HOST_UNAVAILABLE", label: "ホストの都合" },
  { value: "WEATHER", label: "雨・荒天" },
  { value: "ILLNESS", label: "急病・けが" },
  { value: "OTHER", label: "その他" },
] as const;

const OUTCOME_TEXT: Record<string, string> = {
  CANCELLED: "取り消しました。返金を Stripe へ送りました",
  DECLINED: "お断りしました。予約者にメールで届きます",
  REFUND_RETRIED: "返金をもう一度送りました",
  REFUND_CLOSED: "手作業で済んだ返金として閉じました",
  NOT_CANCELLABLE: "状態が変わっていたため、何も変えませんでした。一覧を読み直しました",
  CHANGED: "状態が変わっていたため、何も変えませんでした",
  REQUESTED: "受け付けました",
};
const ERROR_TEXT: Record<string, string> = {
  invalid_input: "入力を確かめてください（金額は支払額より小さく、全額なら「全額」を選びます）",
  conflict: "同時に別の操作があったか、返金できる残額がありません。一覧を読み直してください",
  not_found: "予約が見つかりませんでした",
  unauthenticated: "管理者のログインが切れました。ログインし直してください",
};

const REFUND_STATE = {
  REQUESTED: () => "Stripe の受付待ち（10 分以上。自動の再送は 8 回まで）",
  PENDING: () => "Stripe の処理中（7 日以上）",
  FAILED: (code: string | null) => `返金に失敗（${code ?? "理由不明"}）`,
} as const;

const yen = (amount: number) => `¥${amount.toLocaleString("ja-JP")}`;
const japanTime = (utc: string) => new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(utc));

function BookingFacts({ booking, extra }: { booking: SupportQueueBooking; extra?: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="font-extrabold [overflow-wrap:anywhere]">{booking.experienceTitle}</p>
      <p className="text-ink-soft">
        {booking.localDate} {booking.localStartTime} · {booking.guestName ?? "（保存期間を過ぎた予約者）"} · {yen(booking.totalAmount)}
        {booking.freeCancellationUntilUtc ? ` · 無料取消 ${japanTime(booking.freeCancellationUntilUtc)} まで` : booking.cancellationPolicy === "NONE" ? " · 返金なしの条件" : ""}
      </p>
      <p className="text-xs text-muted">予約番号 {booking.publicBookingId} · 提供者 {booking.providerId}</p>
      {extra}
    </div>
  );
}

type Form = { action: string; key: string; body: Record<string, unknown> } | null;

export function AdminSiteBookings({ initial }: { initial: SupportQueue }) {
  const [queue, setQueue] = useState(initial);
  const [form, setForm] = useState<Form>(null);
  const [pending, setPending] = useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [cancelId, setCancelId] = useState("");

  const refresh = async () => {
    try {
      const response = await fetch(API, { cache: "no-store", credentials: "same-origin" });
      if (response.ok) setQueue(await response.json() as SupportQueue);
    } catch {
      // The list stays as it is; the next action reads it again.
    }
  };

  const send = async () => {
    if (!form || busy) return;
    const request = pending ?? { ...form.body, action: form.action, commandId: crypto.randomUUID() };
    setPending(request);
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(API, { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify(request) });
      const result = await response.json().catch(() => ({})) as { outcome?: string; error?: string; refunds?: { status: string }[] };
      if (!response.ok) {
        // A refusal is final for this command; a server failure may be retried with the same one.
        if (response.status < 500) setPending(null);
        setMessage({ tone: "error", text: ERROR_TEXT[result.error ?? ""] ?? "送れませんでした。もう一度お試しください（同じ操作として送り直します）" });
        return;
      }
      setPending(null);
      setForm(null);
      const waiting = result.refunds?.some((refund) => refund.status === "REQUESTED");
      // A refund the automatic resend is sending right now is not sent a second time (the same lease).
      const inProgress = result.outcome === "REFUND_RETRIED" && result.refunds?.length === 0;
      setMessage({ tone: "ok", text: `${inProgress ? "この返金は、ちょうど自動の再送が進めています。少し待って、一覧を読み直してください" : OUTCOME_TEXT[result.outcome ?? ""] ?? "完了しました"}${waiting ? "（Stripe がまだ受け付けていない返金があります。約 2 分後から自動で送り直します。一覧に残り続けたら、もう一度送ってください）" : ""}` });
      await refresh();
    } catch {
      setMessage({ tone: "error", text: "通信できませんでした。もう一度お試しください（同じ操作として送り直します）" });
    } finally {
      setBusy(false);
    }
  };

  const open = (action: string, key: string, body: Record<string, unknown>) => {
    setPending(null);
    setMessage(null);
    setForm({ action, key, body });
  };
  const set = (patch: Record<string, unknown>) => {
    setPending(null);
    setForm((current) => (current ? { ...current, body: { ...current.body, ...patch } } : current));
  };

  /** The confirmation of the open action, under its row. */
  const confirmPanel = (key: string, title: string, fields: ReactNode, label: string) =>
    form?.key === key ? (
      <div className="mt-3 rounded-xl border border-line bg-sand/50 p-3">
        <p className="font-extrabold">{title}</p>
        <div className="mt-2 grid gap-2">{fields}</div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" className={DANGER} disabled={busy} onClick={() => void send()}>{busy ? "送っています…" : label}</button>
          <button type="button" className={BUTTON} disabled={busy} onClick={() => { setForm(null); setPending(null); }}>やめる</button>
        </div>
      </div>
    ) : null;

  const refundFields = (paid: number) => (
    <>
      <fieldset className="flex flex-wrap gap-3">
        <legend className="sr-only">返金</legend>
        <label className="inline-flex items-center gap-1.5"><input type="radio" checked={(form?.body.refund as { kind?: string } | undefined)?.kind !== "PARTIAL"} onChange={() => set({ refund: { kind: "FULL" } })} />全額 {yen(paid)}（NIHO 手数料も返す）</label>
        <label className="inline-flex items-center gap-1.5"><input type="radio" checked={(form?.body.refund as { kind?: string } | undefined)?.kind === "PARTIAL"} onChange={() => set({ refund: { kind: "PARTIAL", amount: 0 } })} />一部（NIHO 手数料も額に比例して返す）</label>
      </fieldset>
      {(form?.body.refund as { kind?: string } | undefined)?.kind === "PARTIAL" ? (
        <label className="grid gap-1">返金額（円、{yen(paid)} 未満）
          <input type="number" min={1} max={paid - 1} inputMode="numeric" className={FIELD} value={String((form?.body.refund as { amount?: number }).amount || "")} onChange={(event) => set({ refund: { kind: "PARTIAL", amount: Number(event.currentTarget.value) } })} />
        </label>
      ) : null}
    </>
  );
  const noteField = (label: string, key: "note" | "message", required = false) => (
    <label className="grid gap-1">{label}
      <textarea rows={3} maxLength={key === "message" ? 2000 : 1000} required={required} className={`${FIELD} py-2`} value={String(form?.body[key] ?? "")} onChange={(event) => set({ [key]: event.currentTarget.value })} />
    </label>
  );

  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <h1 className="font-display text-2xl font-medium">サイト予約の取消・返金</h1>
      <p className="mt-1 text-ink-soft">このサイトで受けた予約のうち、NIHO サポートの対応が要るもの。全額返金・一部返金とも、NIHO 手数料も返金額に比例して返します（一部返金の額は入力します）。</p>
      <p role="status" className={message ? `mt-4 rounded-xl px-3 py-2 font-bold ${message.tone === "ok" ? "bg-leaf-pale text-moss" : "bg-danger-pale text-danger"}` : "sr-only"}>{message?.text ?? ""}</p>

      <section aria-labelledby="site-requests" className="mt-8">
        <h2 id="site-requests" className="text-lg font-extrabold">取消の依頼（{queue.cancellationRequests.length}）</h2>
        <p className="text-ink-soft">無料取消の期限後に予約者が依頼したもの。予約はまだ確定のままです。</p>
        <ul className="mt-2 grid gap-2">
          {queue.cancellationRequests.map((item) => (
            <li key={item.requestId} className="rounded-2xl border border-line bg-canvas p-4">
              <BookingFacts booking={item} extra={<p className="text-xs text-muted">依頼 {japanTime(item.requestedAtUtc)}</p>} />
              <div className="mt-2 flex flex-wrap gap-2">
                <button type="button" className={BUTTON} onClick={() => open("APPROVE_REQUEST", `approve-${item.requestId}`, { publicBookingId: item.publicBookingId, refund: { kind: "FULL" } })}>取り消して返金する</button>
                <button type="button" className={BUTTON} onClick={() => open("DECLINE_REQUEST", `decline-${item.requestId}`, { publicBookingId: item.publicBookingId, message: "" })}>お断りする</button>
              </div>
              {confirmPanel(`approve-${item.requestId}`, "依頼のとおり取り消します", <>{refundFields(item.totalAmount)}{noteField("メモ（任意・予約者には届きません）", "note")}</>, "取り消して返金する")}
              {confirmPanel(`decline-${item.requestId}`, "依頼をお断りします（予約は確定のまま）", noteField("予約者へのメッセージ（英語・メールで届きます）", "message", true), "お断りを送る")}
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="site-reviews" className="mt-8">
        <h2 id="site-reviews" className="text-lg font-extrabold">確認待ちの支払い（{queue.paymentReviews.length}）</h2>
        <p className="text-ink-soft">仮押さえの期限のあとに届いた支払い。席は確保されていません。受け取った額を全額返金して取り消します。</p>
        <ul className="mt-2 grid gap-2">
          {queue.paymentReviews.map((item) => (
            <li key={item.publicBookingId} className="rounded-2xl border border-line bg-canvas p-4">
              <BookingFacts booking={item} extra={<p className="text-xs text-muted">受領 {yen(item.paidAmount)}{item.paidAtUtc ? ` · ${japanTime(item.paidAtUtc)}` : ""}</p>} />
              <div className="mt-2"><button type="button" className={BUTTON} onClick={() => open("RESOLVE_PAYMENT_REVIEW", `review-${item.publicBookingId}`, { publicBookingId: item.publicBookingId })}>全額を返金して取り消す</button></div>
              {confirmPanel(`review-${item.publicBookingId}`, `${yen(item.paidAmount)} を全額返金して取り消します`, null, "返金して取り消す")}
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="site-refunds" className="mt-8">
        <h2 id="site-refunds" className="text-lg font-extrabold">返金の要対応（{queue.refunds.length}）</h2>
        <p className="text-ink-soft">Stripe が 10 分以上受け付けていない返金、7 日以上終わっていない返金と、失敗した返金。</p>
        <ul className="mt-2 grid gap-2">
          {queue.refunds.map((item) => (
            <li key={item.refundId} className="rounded-2xl border border-line bg-canvas p-4">
              <BookingFacts
                booking={item}
                extra={<p className="text-xs font-bold text-danger">{REFUND_STATE[item.refundStatus](item.failureCode)} · {item.kind === "FULL" ? "全額" : "一部"} {yen(item.amount)} · {japanTime(item.createdAtUtc)}</p>}
              />
              {item.refundStatus === "PENDING" ? (
                <p className="mt-2 text-ink-soft">Stripe の Dashboard で、販売者の口座のこの返金の状態を確かめてください。</p>
              ) : (
                <div className="mt-2 flex flex-wrap gap-2">
                  <button type="button" className={BUTTON} onClick={() => open("RETRY_REFUND", `retry-${item.refundId}`, { refundId: item.refundId })}>{item.refundStatus === "FAILED" ? "もう一度返金する" : "もう一度送る"}</button>
                  {item.refundStatus === "FAILED" ? <button type="button" className={BUTTON} onClick={() => open("CLOSE_REFUND", `close-${item.refundId}`, { refundId: item.refundId, note: "" })}>手作業で済ませた</button> : null}
                </div>
              )}
              {confirmPanel(`retry-${item.refundId}`, `${yen(item.amount)} の返金を Stripe へ送ります`, null, "送る")}
              {confirmPanel(`close-${item.refundId}`, "この返金を一覧から外します（Stripe では返金しません）", noteField("どう済ませたか（必須）", "note", true), "閉じる")}
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="site-cancel" className="mt-8">
        <h2 id="site-cancel" className="text-lg font-extrabold">予約番号で取り消す</h2>
        <p className="text-ink-soft">確定している予約を、全額または一部の返金で取り消します。ホストに通知が届きます。</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <label className="grid min-w-72 flex-1 gap-1">予約番号
            <input className={FIELD} value={cancelId} onChange={(event) => setCancelId(event.currentTarget.value.trim())} />
          </label>
          <button type="button" className={`${BUTTON} self-end`} disabled={!cancelId} onClick={() => open("CANCEL", "cancel-by-id", { publicBookingId: cancelId, refund: { kind: "FULL" }, reason: "", note: "" })}>取り消す</button>
        </div>
        {confirmPanel(
          "cancel-by-id",
          `予約 ${String(form?.body.publicBookingId ?? "")} を取り消します`,
          <>
            <label className="grid gap-1">取消理由
              <select className={FIELD} value={String(form?.body.reason ?? "")} onChange={(event) => set({ reason: event.currentTarget.value })}>
                <option value="">選んでください</option>
                {REASONS.map((reason) => <option key={reason.value} value={reason.value}>{reason.label}</option>)}
              </select>
            </label>
            <fieldset className="flex flex-wrap gap-3">
              <legend className="sr-only">返金</legend>
              <label className="inline-flex items-center gap-1.5"><input type="radio" checked={(form?.body.refund as { kind?: string } | undefined)?.kind !== "PARTIAL"} onChange={() => set({ refund: { kind: "FULL" } })} />全額（NIHO 手数料も返す）</label>
              <label className="inline-flex items-center gap-1.5"><input type="radio" checked={(form?.body.refund as { kind?: string } | undefined)?.kind === "PARTIAL"} onChange={() => set({ refund: { kind: "PARTIAL", amount: 0 } })} />一部（NIHO 手数料も額に比例して返す）</label>
            </fieldset>
            {(form?.body.refund as { kind?: string } | undefined)?.kind === "PARTIAL" ? (
              <label className="grid gap-1">返金額（円、支払額未満）
                <input type="number" min={1} inputMode="numeric" className={FIELD} value={String((form?.body.refund as { amount?: number }).amount || "")} onChange={(event) => set({ refund: { kind: "PARTIAL", amount: Number(event.currentTarget.value) } })} />
              </label>
            ) : null}
            {noteField("メモ（任意・予約者には届きません）", "note")}
          </>,
          "取り消して返金する",
        )}
      </section>
    </main>
  );
}
