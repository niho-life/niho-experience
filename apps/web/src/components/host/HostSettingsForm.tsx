"use client";

import { useEffect, useId, useRef, useState, useTransition, type FormEvent, type ReactNode } from "react";
import { saveNotificationSettings, saveProviderMeetingPoint, saveProviderProfile, submitProviderReview } from "@/host/actions";
import { normalizeMeetingPoint, sameMeetingPoint } from "@/host/meeting-point";
import { notificationChanges, notificationPanelView, notificationRows, toggleNotification } from "@/host/notifications";
import { reviewRow, saveNeedsReviewConfirm, type HostNotice, type HostPayoutLoad, type ProviderProfile } from "@/host/payout";
import { PREPARING_STATUS, PROVIDER_REVIEW_STATUS } from "@/host/status";
import type { HostGoogleConnection, HostMeetingDefaults, HostNotificationKey, HostSettings } from "@/host/types";
import type { HostProviderRole } from "@/lib/host/providers";
import { HOST_CALENDAR_PATH, withProvider } from "@/lib/host/routes";
import { DISABLED } from "./editor-parts";
import { FIELD_DISABLED, FieldRow, FieldSection, INPUT, KindSegment, NARROW, TEXTAREA } from "./fields";
import { MeetingPointFields } from "./MeetingPointFields";
import { HostCalendarPanel } from "./HostCalendarPanel";
import { HostConfirmDialog } from "./HostConfirmDialog";
import { consoleButtonClass } from "./host-ui";
import { HostIcon } from "./HostIcon";
import { HostNoticeLine } from "./HostNoticeLine";
import { HostNotificationPanel } from "./HostNotificationPanel";
import { HostPayoutPanel } from "./HostPayoutPanel";
import { StatusPill } from "./ui";

/** The fields of 提供者情報 that differ from what NIHO has (the seller page only for the owner). */
function changedFields(saved: ProviderProfile, now: ProviderProfile, owner: boolean): Partial<ProviderProfile> {
  const changes: Partial<ProviderProfile> = {};
  if (now.displayName !== saved.displayName) changes.displayName = now.displayName;
  if (now.bio !== saved.bio) changes.bio = now.bio;
  if (owner && now.sellerDisclosureUrl.trim() !== saved.sellerDisclosureUrl) changes.sellerDisclosureUrl = now.sellerDisclosureUrl;
  return changes;
}

export interface HostSettingsFormProps {
  providerId: string;
  role: HostProviderRole | null;
  settings: HostSettings;
  payout: HostPayoutLoad;
  /** What Stripe's way back (`?connect=`) led to. */
  connectNotice: HostNotice | null;
  /** The Google account カレンダー's つなぐ connects in the preview; null in http mode. */
  googleConnection: HostGoogleConnection | null;
  /** Mock mode: the parts NIHO cannot keep yet (カレンダー・通知) can be tried on screen, and 集合案内 is kept on screen only. */
  preview: boolean;
  /** The account panel, passed in because its sign-out form cannot sit inside this form. */
  account: ReactNode;
}

/**
 * 設定 (mock v2): one panel per group and one 保存. 提供者情報 is NIHO's (#88/#91): 保存 sends
 * the fields that changed to the provider API and shows what NIHO kept; a reviewed provider is
 * asked first, as saving sends it back to review. 既定の集合案内 (#89, OWNER and EDITOR) is NIHO's
 * too and saved after 提供者情報 by the same 保存; changing it stops every listed experience of the
 * provider, so the host is asked first (one dialog with the review's sentence when both apply). The
 * preview keeps it on screen only. 審査を申請, the payout account and カレンダー (#109) work on their
 * own. 通知 (#109: the three notifications the owner may stop) is kept by 保存 in the experience DB
 * once it is open there (`settings.notificationSource`), on screen only in the preview, and 準備中
 * until then.
 *
 * Only 提供者情報 and the payout account sit inside the <form>: カレンダー's dialogs are forms of
 * their own, and a form cannot hold another. The meeting fields join it with `form`, so 保存 still
 * checks them.
 */
export function HostSettingsForm({ providerId, role, settings, payout: initialPayout, connectNotice, googleConnection, preview, account }: HostSettingsFormProps) {
  const ids = useId();
  const formId = `${ids}-form`;
  const owner = role === "OWNER";
  const initialProfile: ProviderProfile = { displayName: settings.displayName, bio: settings.bio, sellerDisclosureUrl: settings.sellerDisclosureUrl };
  const [saved, setSaved] = useState(initialProfile);
  const [profile, setProfile] = useState(initialProfile);
  const [reviewStatus, setReviewStatus] = useState(settings.reviewStatus);
  const [payout, setPayout] = useState(initialPayout);
  const [notice, setNotice] = useState<HostNotice | null>(null);
  const [reviewNotice, setReviewNotice] = useState<HostNotice | null>(null);
  const [confirming, setConfirming] = useState(false);
  // 既定の集合案内: NIHO answers it to the OWNER and EDITOR only; null could not be read.
  const meetingEditable = settings.meetingPoint !== null && (role === "OWNER" || role === "EDITOR");
  const [savedMeeting, setSavedMeeting] = useState<HostMeetingDefaults | null>(settings.meetingPoint);
  const [meeting, setMeeting] = useState<HostMeetingDefaults | null>(settings.meetingPoint);
  const notificationView = notificationPanelView(settings.notifications, role, settings.notificationSource);
  const [savedNotifications, setSavedNotifications] = useState(notificationView.kind === "owner" ? notificationView.rows : []);
  const [notifications, setNotifications] = useState(savedNotifications);
  const [saving, startSaving] = useTransition();
  const [submitting, startSubmitting] = useTransition();
  const stay = useRef<HTMLButtonElement>(null);

  const changes = changedFields(saved, profile, owner);
  const unsaved = Object.keys(changes).length > 0;
  const meetingChanged = meetingEditable && meeting !== null && savedMeeting !== null && !sameMeetingPoint(meeting, savedMeeting);
  // The preview keeps the meeting point on screen: nothing of NIHO's stops there.
  const meetingConfirm = meetingChanged && !preview;
  const reviewConfirm = unsaved && saveNeedsReviewConfirm(reviewStatus);
  const review = reviewRow({
    reviewStatus,
    role,
    savedSellerUrl: saved.sellerDisclosureUrl,
    unsaved,
    payoutReady: payout.status === "owner" && payout.payout.reason === "READY",
    consentCurrent: settings.consentCurrent,
  });

  // Stripe sent the host back (?connect=): the page has read the account again. Take the query
  // away so a reload does not repeat it, and bring the account into view.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("connect")) return;
    url.searchParams.delete("connect");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    document.getElementById("settings-payout")?.scrollIntoView({ block: "start" });
  }, []);

  const edit = (field: keyof ProviderProfile, value: string) => {
    setProfile((current) => ({ ...current, [field]: value }));
    setNotice(null);
  };

  const toggle = (key: HostNotificationKey, enabled: boolean) => {
    setNotifications((current) => toggleNotification(current, key, enabled));
    setNotice(null);
  };

  /**
   * The notifications that changed: the experience DB keeps them and answers all seven as they are
   * now (#109); the preview "saves" them as they are on screen. The error to show, or null.
   */
  const saveNotifications = async (): Promise<HostNotice | null> => {
    const changed = notificationChanges(savedNotifications, notifications);
    if (Object.keys(changed).length === 0) return null;
    if (settings.notificationSource !== "live") {
      setSavedNotifications(notifications);
      return null;
    }
    const result = await saveNotificationSettings({ providerId, changes: changed });
    if (!result.ok) return { tone: "error", message: result.message };
    const rows = notificationRows(result.items);
    setSavedNotifications(rows);
    setNotifications(rows);
    return null;
  };

  /** The meeting point as NIHO keeps it now: the preview's on-screen one, trimmed. */
  const keepMeeting = (value: HostMeetingDefaults) => {
    setSavedMeeting(value);
    setMeeting(value);
  };

  const commit = () => {
    setNotice(null);
    const meetingNow = meetingChanged && meeting ? normalizeMeetingPoint(meeting) : null;
    if (meetingChanged && !meetingNow) {
      setNotice({ tone: "error", message: "既定の集合案内の地図 URL は https:// で始まる URL にしてください。" });
      return;
    }
    startSaving(async () => {
      // 提供者情報, then the meeting point, then 通知: a refused later part leaves the earlier ones saved.
      let message = "保存しました";
      const savedParts: string[] = [];
      if (unsaved) {
        const result = await saveProviderProfile({ providerId, ...changes });
        if (!result.ok) {
          setNotice({ tone: "error", message: result.message });
          return;
        }
        setSaved(result.profile);
        setProfile(result.profile);
        setReviewStatus(result.reviewStatus);
        message = result.message;
        savedParts.push("提供者情報");
      }
      if (meetingNow && preview) keepMeeting(meetingNow);
      else if (meetingNow) {
        const result = await saveProviderMeetingPoint({ providerId, meetingPoint: meetingNow });
        if (!result.ok) {
          setNotice({ tone: "error", message: unsaved ? "提供者情報は保存しました。既定の集合案内は保存できませんでした。" : result.message });
          return;
        }
        keepMeeting(result.meetingPoint);
        message = result.message;
        savedParts.push("既定の集合案内");
      }
      const failed = await saveNotifications();
      if (failed) {
        setNotice({ tone: "error", message: savedParts.length ? `${savedParts.join("と")}は保存しました。${failed.message}` : failed.message });
        return;
      }
      setNotice({ tone: "success", message });
    });
  };

  // The browser has checked the fields (required, https) before this runs.
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;
    if (reviewConfirm || meetingConfirm) setConfirming(true);
    else commit();
  };

  const requestReview = () => {
    setReviewNotice(null);
    startSubmitting(async () => {
      const result = await submitProviderReview({ providerId });
      if (!result.ok) {
        setReviewNotice({ tone: "error", message: result.message });
        return;
      }
      setReviewStatus(result.reviewStatus);
      setReviewNotice({ tone: "success", message: result.message });
    });
  };

  const sellerOwnerHelp = `${ids}-seller-owner`;
  const kindHelp = `${ids}-kind-help`;
  const reviewWhy = `${ids}-review-why`;

  return (
    <>
      <div className="flex flex-col gap-3.5">
        <form id={formId} className="flex flex-col gap-3.5" onSubmit={submit}>
          <FieldSection id="settings-provider" title="提供者情報" status={reviewStatus ? PROVIDER_REVIEW_STATUS[reviewStatus] : null}>
            <FieldRow label="掲載名" htmlFor="settings-display-name">
              <input
                id="settings-display-name"
                required
                maxLength={100}
                pattern=".*\S.*"
                title="掲載名を入力してください"
                value={profile.displayName}
                onChange={(event) => edit("displayName", event.currentTarget.value)}
                className={`${INPUT} ${NARROW}`}
              />
            </FieldRow>
            <FieldRow label="種別" labelId="settings-kind-label">
              <KindSegment name="settings-kind" labelId="settings-kind-label" defaultValue={settings.kind} disabled describedBy={kindHelp} />
              <p id={kindHelp} className="mt-1 text-xs text-muted">
                種別を変えるときは NIHO にお問い合わせください。
              </p>
            </FieldRow>
            <FieldRow label="紹介" htmlFor="settings-bio">
              <textarea id="settings-bio" rows={3} maxLength={4000} value={profile.bio} onChange={(event) => edit("bio", event.currentTarget.value)} className={TEXTAREA} />
            </FieldRow>
            <FieldRow label="販売者表示" labelId="settings-seller-label">
              {/* The seller's legal page (特商法表示): the provider's own site. NIHO's page for providers without one is not in the contract yet. */}
              <div role="group" aria-labelledby="settings-seller-label" className="flex flex-col gap-1.5">
                <label className="inline-flex min-h-8 items-center gap-2.5 font-bold">
                  <input type="radio" name="settings-seller-display" value="own-site" defaultChecked disabled={!owner} className="size-4 shrink-0 accent-moss" />
                  自分のサイトに表示する
                </label>
                <div className="pl-[26px]">
                  <label htmlFor="settings-seller-url" className="mb-1 block text-xs font-bold text-muted">
                    特商法表示 URL
                  </label>
                  <input
                    id="settings-seller-url"
                    type="url"
                    inputMode="url"
                    placeholder="https://"
                    pattern="https://.+"
                    title="https:// で始まる URL を入力してください"
                    maxLength={2048}
                    value={profile.sellerDisclosureUrl}
                    disabled={!owner}
                    aria-describedby={owner ? undefined : sellerOwnerHelp}
                    onChange={(event) => edit("sellerDisclosureUrl", event.currentTarget.value)}
                    className={`${INPUT} ${NARROW} ${FIELD_DISABLED}`}
                  />
                  {owner ? null : (
                    <p id={sellerOwnerHelp} className="mt-1 text-xs text-muted">
                      特商法表示 URL はオーナーが変えられます。
                    </p>
                  )}
                </div>
                <label className="inline-flex min-h-8 flex-wrap items-center gap-x-2.5 gap-y-1 text-ink-soft">
                  <input type="radio" name="settings-seller-display" value="niho-page" disabled className="size-4 shrink-0" />
                  NIHO のページに表示する（自前サイトがない事業者）
                  <StatusPill status={PREPARING_STATUS} />
                </label>
              </div>
            </FieldRow>
            {review ? (
              <FieldRow label="審査" labelId="settings-review-label">
                <div role="group" aria-labelledby="settings-review-label" className="flex min-h-10 flex-wrap items-center gap-x-2.5 gap-y-1">
                  {review.kind === "submit" ? (
                    <>
                      <button
                        type="button"
                        disabled={review.blocker !== null || submitting}
                        aria-describedby={review.blocker ? reviewWhy : undefined}
                        onClick={requestReview}
                        className={consoleButtonClass("secondary", "sm", DISABLED)}
                      >
                        {submitting ? "申請しています…" : "審査を申請"}
                      </button>
                      {review.blocker ? (
                        <span id={reviewWhy} className="text-[0.78125rem] text-muted">
                          {review.blocker}
                        </span>
                      ) : null}
                    </>
                  ) : (
                    <span className="text-ink-soft">{review.text}</span>
                  )}
                </div>
                <HostNoticeLine notice={reviewNotice} className="pt-1" />
              </FieldRow>
            ) : (
              <HostNoticeLine notice={reviewNotice} className="pt-1" />
            )}
          </FieldSection>

          {owner ? <HostPayoutPanel providerId={providerId} displayName={saved.displayName} payout={payout} onPayout={setPayout} initialNotice={connectNotice} /> : null}
        </form>

        {preview ? <HostCalendarPanel calendar={settings.calendar} connection={googleConnection} preview /> :
          <FieldSection id="settings-calendar" title="カレンダー" status={null}>
            <FieldRow label="開催枠と Google の予定" labelId="settings-calendar-link">
              <a href={withProvider(HOST_CALENDAR_PATH, providerId)} className="font-bold text-moss underline underline-offset-4">カレンダーを開く</a>
            </FieldRow>
          </FieldSection>}

        <FieldSection id="settings-meeting" title="既定の集合案内" status={null}>
          {meetingEditable && meeting ? (
            <MeetingPointFields idPrefix="settings-meeting" value={meeting} form={formId} onChange={(value) => { setMeeting(value); setNotice(null); }} />
          ) : (
            <p className="text-ink-soft">{role === "OWNER" || role === "EDITOR" ? "既定の集合案内を読めませんでした。" : "既定の集合案内はオーナーと編集者が変えられます。"}</p>
          )}
        </FieldSection>

        <HostNotificationPanel view={notificationView} rows={notifications} onToggle={toggle} />
      </div>

      <div className="mt-3.5">{account}</div>

      {/* PC: a leaf pill floating at the bottom right. Phones: a full-width band just above the bottom tabs. */}
      <div className="sticky bottom-[var(--host-tabbar)] z-10 -mx-4 mt-4 -mb-6 border-t border-line bg-canvas px-4 pt-2.5 pb-3.5 md:pointer-events-none md:bottom-4 md:mx-0 md:mb-0 md:flex md:items-center md:justify-end md:gap-3 md:border-0 md:bg-transparent md:p-0">
        <p role="status" className="text-center text-[0.78125rem] font-extrabold text-moss md:text-right">
          {notice?.tone === "success" ? (
            <span className="inline-flex items-center gap-1 pb-2 md:rounded-full md:bg-canvas md:px-3 md:py-1.5">
              <HostIcon name="check" className="size-3.5" />
              {notice.message}
            </span>
          ) : null}
        </p>
        {notice?.tone === "error" ? (
          <p role="alert" className="pb-2 text-center text-[0.78125rem] font-extrabold text-danger md:pointer-events-auto md:rounded-2xl md:bg-canvas md:px-3 md:py-1.5 md:text-right">
            {notice.message}
          </p>
        ) : null}
        <button
          type="submit"
          form={formId}
          disabled={saving}
          className="block h-12 w-full rounded-xl bg-leaf text-[0.9375rem] font-extrabold text-ink hover:bg-leaf-hover disabled:opacity-60 md:pointer-events-auto md:h-11 md:w-auto md:rounded-full md:px-6 md:shadow-[0_8px_24px_rgb(0_0_0/0.14)]"
        >
          {saving ? "保存しています…" : "保存"}
        </button>
      </div>

      {confirming ? (
        <HostConfirmDialog
          title={reviewConfirm && meetingConfirm ? "提供者情報と既定の集合案内を保存しますか？" : reviewConfirm ? "提供者情報を保存しますか？" : "既定の集合案内を保存しますか？"}
          description={[
            reviewConfirm ? (reviewStatus === "APPROVED" ? "保存すると NIHO の再審査（審査待ち）になり、審査が済むまで掲載中の体験は止まります。" : "保存すると NIHO の再審査（審査待ち）になります。") : null,
            meetingConfirm ? "この提供者の掲載中の体験はすべて止まり、NIHO がもう一度確認するまで体験サイトに出ません。" : null,
          ].filter(Boolean).join("")}
          focusRef={stay}
          stayRef={stay}
          confirm={
            <button type="submit" className={consoleButtonClass("primary")}>
              {reviewConfirm ? "保存して再審査を受ける" : "保存する"}
            </button>
          }
          onConfirm={commit}
          onClose={() => setConfirming(false)}
        />
      ) : null}
    </>
  );
}
