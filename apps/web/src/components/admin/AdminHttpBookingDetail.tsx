import type { ExperienceAdminBookingDetailResponse } from "@niho-experience/api-client/admin-read";
import { adminHttpBookingStatus, adminHttpSupportLabel } from "@/admin/http-view";
import { adminDateTime } from "@/admin/date-time";
import { yen } from "@/host/format";
import { HOST_SURFACE } from "@/components/host/host-ui";
import { StatusPill } from "@/components/host/ui";
import { AdminSupportCaseEditor } from "./AdminSupportCaseEditor";
import { AdminBookingOperations } from "./AdminBookingOperations";
import { FeeSummaryPanel } from "@/components/FeeSummaryPanel";

function Heading({ children }: { children: string }) {
  return <h3 className="mb-2 font-sans text-xs font-extrabold tracking-[0.04em] text-ink-soft">{children}</h3>;
}

function Value({ children }: { children: React.ReactNode }) {
  return <dd className="min-w-0 [overflow-wrap:anywhere]">{children}</dd>;
}

export function AdminHttpBookingDetail({ response, supportCaseEnabled, operationsEnabled, feeSummaryEnabled, operationId, onSessionExpired }: { response: ExperienceAdminBookingDetailResponse; supportCaseEnabled: boolean; operationsEnabled: boolean; feeSummaryEnabled: boolean; operationId: string | null; onSessionExpired: () => void }) {
  const { booking, supportAgreement } = response;
  const support = adminHttpSupportLabel(booking.support);
  const hostKind = booking.host.kind === "SPOT" ? "通常拠点" : "外部提供者";
  return <article aria-labelledby="admin-http-booking-detail-title" className={`${HOST_SURFACE} min-w-0 p-4 md:px-5 md:py-[18px]`}>
    <div className="flex flex-wrap items-start justify-between gap-2.5">
      <div className="min-w-0"><p className="text-xs font-extrabold text-muted">予約ID {booking.id}</p><h2 id="admin-http-booking-detail-title" tabIndex={-1} className="font-sans text-[1.125rem] font-extrabold tracking-normal focus:outline-none">{booking.guestName || "予約者名は保持されていません"}</h2><p className="mt-0.5 text-[0.78125rem] text-muted">{adminDateTime(booking.startAt)}〜{adminDateTime(booking.endAt)}</p></div>
      <StatusPill status={adminHttpBookingStatus(booking.status)} />
    </div>

    <section className="mt-4 border-t border-line pt-4"><Heading>受付時の支援条件</Heading>
      <div className="flex flex-wrap items-center gap-2"><span className={`rounded-full px-2.5 py-1 text-xs font-extrabold ${support.className}`}>{support.label}</span>{booking.support.kind === "valid" ? <span className="text-[0.8125rem]">手数料 {booking.support.snapshot.totalRateBps / 100}%</span> : null}</div>
      {booking.support.kind === "valid" ? <p className="mt-2 text-[0.8125rem] text-ink-soft">受付時の同意内容: 版 {booking.support.snapshot.consentVersion} · 改訂 {booking.support.snapshot.agreementRevision} · {booking.support.normalOperationsAllowed ? "支援操作の対象" : "支援操作の対象外"}</p> : <p className="mt-2 text-[0.8125rem] font-bold text-warn">受付時の支援条件を確認できません。料金率やON/OFFは補完せず、個別に確認してください。</p>}
      <p className="mt-2 text-[0.8125rem] text-muted">通訳やお手伝いの人件費は別途、ホストから担当者へ直接支払います。</p>
      <p className="mt-2 text-[0.8125rem]"><strong>ホスト共有の相談メモ:</strong> {supportAgreement.sharedConsultationMemo || "未記入"}</p>
      <p className="mt-1 text-xs text-muted">この相談メモはホストと共有する内容です。下の事務局内部メモとは別です。</p>
      {booking.support.kind === "valid" ? <p className={`mt-1 text-xs ${supportAgreement.matchesBookingSnapshot ? "text-muted" : "font-extrabold text-warn"}`}>{supportAgreement.matchesBookingSnapshot ? "現在の支援設定と受付時の同意内容は一致しています。" : "現在の支援設定と受付時の同意内容が異なります。受付時の内容を基準に確認してください。"}</p> : <p className="mt-1 text-xs font-extrabold text-warn">現在の支援設定との一致は確認できません。</p>}
    </section>

    <section className="mt-4 border-t border-line pt-4"><Heading>予約内容</Heading><dl className="grid grid-cols-[88px_minmax(0,1fr)] gap-x-2 gap-y-2 text-[0.8125rem]">
      <dt className="font-bold text-muted">体験</dt><Value>{booking.page.title} / {booking.offerName}</Value>
      <dt className="font-bold text-muted">開催日</dt><Value>{booking.occurrenceDate}</Value>
      <dt className="font-bold text-muted">人数</dt><Value>{booking.headCount}名（大人 {booking.adultCount} / 子ども {booking.childCount}）</Value>
      <dt className="font-bold text-muted">ホスト</dt><Value>{booking.host.displayName}（{hostKind}）</Value>
      <dt className="font-bold text-muted">言語</dt><Value>{booking.languageSnapshot || "未記入"}</Value>
      <dt className="font-bold text-muted">販売経路</dt><Value>{booking.salesChannel || "未記入"}</Value>
      <dt className="font-bold text-muted">予約者メール</dt><Value>{booking.guestEmail || "保持期間終了または未登録"}</Value>
      <dt className="font-bold text-muted">備考</dt><Value>{booking.note || "未記入"}</Value>
    </dl>
    {booking.answers === null ? <p className="mt-3 text-xs text-muted">質問回答はまだ取得できません。</p> : booking.answers.length ? <dl className="mt-3 grid gap-2">{booking.answers.map((answer) => <div key={answer.questionId} className="rounded-xl bg-sand/55 p-3 text-[0.8125rem]"><dt className="font-extrabold">{answer.prompt}</dt><dd className="mt-1 whitespace-pre-wrap">{answer.text ?? answer.options.map((option) => option.label).join(" / ")}</dd></div>)}</dl> : <p className="mt-3 text-xs text-muted">質問項目はありません。</p>}
    </section>

    <section className="mt-4 border-t border-line pt-4"><Heading>金額・決済状態</Heading><dl className="grid grid-cols-[88px_minmax(0,1fr)] gap-x-2 gap-y-2 text-[0.8125rem]">
      <dt className="font-bold text-muted">合計</dt><Value>{yen(booking.totalYen)}</Value>
      <dt className="font-bold text-muted">返金済み</dt><Value>{yen(booking.refundedYen)}</Value>
      <dt className="font-bold text-muted">支払時刻</dt><Value>{booking.paidAt ? adminDateTime(booking.paidAt) : "未記録"}</Value>
      <dt className="font-bold text-muted">与信時刻</dt><Value>{booking.authorizedAt ? adminDateTime(booking.authorizedAt) : "未記録"}</Value>
      <dt className="font-bold text-muted">承認期限</dt><Value>{booking.approvalDeadlineAt ? adminDateTime(booking.approvalDeadlineAt) : "未設定"}</Value>
      <dt className="font-bold text-muted">取消申出</dt><Value>{booking.travelerCancelRequestedAt ? adminDateTime(booking.travelerCancelRequestedAt) : "未記録"}</Value>
      <dt className="font-bold text-muted">取消時刻</dt><Value>{booking.cancelledAt ? adminDateTime(booking.cancelledAt) : "未記録"}</Value>
      <dt className="font-bold text-muted">取消理由</dt><Value>{booking.cancelReason || "未記録"}</Value>
      <dt className="font-bold text-muted">取消の連絡</dt><Value><span className="whitespace-pre-wrap">{booking.cancelMessage || "未記録"}</span></Value>
    </dl></section>

    <FeeSummaryPanel key={`admin-fee-${booking.id}`} audience="admin" bookingId={booking.id} actorKey="current-admin" enabled={feeSummaryEnabled} onSessionExpired={onSessionExpired} />

    <section className="mt-4 border-t border-line pt-4"><Heading>メッセージ配信状態</Heading>{booking.hostMessages.length ? <ul className="grid gap-2">{booking.hostMessages.map((message) => <li key={message.id} className="rounded-xl bg-sand/55 p-3 text-[0.8125rem]"><strong>{message.subject || "件名なし"}</strong><span className="mt-1 block text-muted">{message.deliveryStatus} · 作成 {adminDateTime(message.createdAt)}{message.sentAt ? ` · 送信 ${adminDateTime(message.sentAt)}` : ""}</span></li>)}</ul> : <p className="text-[0.8125rem] text-muted">この予約には配信記録がありません。</p>}</section>

    <AdminSupportCaseEditor key={booking.id} bookingId={booking.id} enabled={supportCaseEnabled} onSessionExpired={onSessionExpired} />

    <AdminBookingOperations key={`operations-${booking.id}`} bookingId={booking.id} enabled={operationsEnabled} recoveredOperationId={operationId} onSessionExpired={onSessionExpired} />
  </article>;
}
