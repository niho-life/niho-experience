import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { FieldRow, FieldSection } from "@/components/host/fields";
import { HostAppInstall } from "@/components/host/HostAppInstall";
import { HostNihoAccountRow, type NihoAccountRowStatus } from "@/components/host/HostNihoAccountRow";
import { HostNotificationAddress } from "@/components/host/HostNotificationAddress";
import { HostPushToggle } from "@/components/host/HostPushToggle";
import { HostIcon } from "@/components/host/HostIcon";
import { HostRegisterPrompt } from "@/components/host/HostRegisterPrompt";
import { HostSettingsForm } from "@/components/host/HostSettingsForm";
import type { HostSettingsSection } from "@/lib/host/settings-navigation";
import { HostSettingsIndex } from "@/components/host/HostSettingsIndex";
import { HostOperatingTeamPanel } from "@/components/host/HostOperatingTeamPanel";
import { HostSupportSettingsPanel } from "@/components/host/HostSupportSettingsPanel";
import { HostPayoutAccountPanel } from "@/components/host/HostPayoutAccountPanel";
import { HostArticleLinksPanel } from "@/components/host/HostArticleLinksPanel";
import { consoleButtonClass } from "@/components/host/host-ui";
import { AccountAvatar, HostPageBody, PageHead } from "@/components/host/ui";
import { loadHostCalendar } from "@/host/calendar-server";
import { hostPageContext, loadHostConsoleData, loadHostPayout, type HostPayoutData } from "@/host/data";
import { hostPayoutLoadOf, PAYOUT_CONSENT_OUTCOMES, payoutConsentOutcomeOrNull, type ExperiencePayoutLoad } from "@/host/payout-account";
import { loadExperiencePayout } from "@/host/payout-account-server";
import { NOTIFICATION_ADDRESS_TEXT, previewNotificationAddress } from "@/host/notification-address";
import { loadNotificationAddress } from "@/host/notification-address-server";
import { config } from "@/lib/config";
import { resolveCalendarContext } from "@/lib/experience/calendar-actor";
import { nihoIdentityOutcomeOrNull, type NihoIdentityOutcome } from "@/lib/host/niho-identity";
import { loadNihoIdentityStatus } from "@/lib/host/niho-identity-server";
import { HOST_LOGOUT_PATH, HOST_SETTINGS_PATH, withProvider } from "@/lib/host/routes";
import { HOST_SETTINGS_SECTION_TITLES, hostSettingsSectionOrNull } from "@/lib/host/settings-navigation";
import type { HostSession } from "@/lib/host/session";
import { isHostMock } from "@/lib/host/server";
import { providerOperationsEnabled } from "@/lib/host/provider-operations-server";

export const metadata: Metadata = { title: "設定" };

type SearchParams = Record<string, string | string[] | undefined>;

/** Stripe's way back to this page (`?connect=`), as NIHO sets it for the account page's return and refresh URLs. */
function connectStep(value: string | string[] | undefined): "return" | "refresh" | null {
  return value === "return" || value === "refresh" ? value : null;
}

/**
 * アカウント: the NIHO account (or, with Experience host accounts, the address the host signs in with, and with the NIHO
 * account login the NIHO account it is bound to, Epic #591) and ログアウト (its form cannot sit inside the settings form).
 */
function AccountPanel({ session, niho = null }: { session: Pick<HostSession, "kind" | "displayName" | "iconUrl">; niho?: { providerId: string | null; status: NihoAccountRowStatus; outcome: NihoIdentityOutcome | null } | null }) {
  const account = { displayName: session.displayName, iconUrl: session.iconUrl };
  const experience = session.kind === "experience";
  return (
    <FieldSection id="settings-account" title="アカウント">
      <FieldRow label={experience ? "ログインのメール" : "NIHO アカウント"} labelId="settings-account-label">
        <div role="group" aria-labelledby="settings-account-label" className="flex min-h-10 flex-wrap items-center gap-2.5">
          <AccountAvatar account={account} className="size-6 text-[0.75rem]" />
          <span className="[overflow-wrap:anywhere]">{account.displayName || (experience ? "" : "NIHO アカウント")}</span>
          {experience ? null : (
            <a href={config.nihoWebOrigin} className={consoleButtonClass("secondary", "sm")}>
              <HostIcon name="external" className="size-3.5" />
              NIHO アプリ
            </a>
          )}
        </div>
      </FieldRow>
      {niho ? <HostNihoAccountRow providerId={niho.providerId} status={niho.status} outcome={niho.outcome} /> : null}
      <div className="border-t border-line pt-3 md:pl-[184px]">
        <form method="post" action={HOST_LOGOUT_PATH} data-niho-navigation-form>
          <button type="submit" className={consoleButtonClass("ghost", "sm")}>
            ログアウト
          </button>
        </form>
      </div>
    </FieldSection>
  );
}

/**
 * 設定 for a product operator (#194, docs/product-operators.md): no provider settings, only where this site's emails go
 * (the OTA bookings of their products come to them) and the account. Only while this site emails hosts.
 */
async function OperatorSettings({ providerId, session, niho }: { providerId: string; session: HostSession; niho: Parameters<typeof AccountPanel>[0]["niho"] }) {
  const load = await loadNotificationAddress(providerId);
  return (
    <HostPageBody>
      <PageHead title="設定" />
      <FieldSection id="settings-notification" title="通知">
        <FieldRow label="宛先" labelId="settings-notification-to">
          {load.status === "live" ? (
            <HostNotificationAddress providerId={providerId} initial={load.address} labelId="settings-notification-to" />
          ) : (
            <p role="alert" className="flex min-h-10 items-center text-danger">{NOTIFICATION_ADDRESS_TEXT.loadFailed}</p>
          )}
        </FieldRow>
        <FieldRow label="届く通知" labelId="settings-notification-items">
          <p className="flex min-h-10 items-center text-ink-soft">担当の体験の、予約サイトでの新しい予約・取消・日時変更が届きます。</p>
        </FieldRow>
      </FieldSection>
      <div className="mt-3.5">
        <AccountPanel session={session} niho={niho} />
      </div>
    </HostPageBody>
  );
}

/** 受取口座 with Experience host accounts (ADR 0003 slice 3): Stripe and the OWNER's consent, never NIHO. */
async function loadAccountPayout(session: HostSession, provider: Parameters<typeof loadExperiencePayout>[1]): Promise<{ payout: HostPayoutData; experience: ExperiencePayoutLoad } | null> {
  if (session.kind !== "experience") return null;
  const experience = await loadExperiencePayout(session, provider);
  return { experience, payout: { load: hostPayoutLoadOf(experience), notice: null, redirectTo: null } };
}

/** The NIHO account row's data (Epic #591): with the NIHO account login on, for a host account's own session only. */
async function nihoAccount(session: HostSession, providerId: string | null, query: SearchParams) {
  if (session.kind !== "experience" || !config.hostNihoLoginEnabled) return null;
  return { providerId, status: await loadNihoIdentityStatus(session.hostAccountId), outcome: nihoIdentityOutcomeOrNull(Array.isArray(query.niho) ? query.niho[0] : query.niho) };
}

/**
 * 設定 (mock v2): provider (and its review), payout account, calendar (#109), default meeting point,
 * notifications (#109, and their address #194), this device as an app and its push (#177, HOST_PWA_ENABLED / HOST_PUSH_ENABLED) and the NIHO account. `?connect=return` (back from Stripe's page) reads the account from Stripe
 * again first; `?connect=refresh` (its link expired) sends the host back to Stripe with a new one. With Experience host
 * accounts 受取口座 is the account Admin/ops registered, read from Stripe, with the OWNER's consent (`?payout=` after its
 * form says what happened).
 */
export default async function HostSettingsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const query = await searchParams;
  const context = await hostPageContext(query);
  if (!context) return null;
  const { session, provider, providerNotFound } = context;
  if (!provider) {
    // A product operator (#194): their own address for this site's emails, while it sends them.
    const calendar = config.hostMailEnabled ? await resolveCalendarContext(query) : null;
    if (calendar?.choice?.kind === "OPERATOR") return <OperatorSettings providerId={calendar.choice.id} session={session} niho={await nihoAccount(session, null, query)} />;
    return <HostRegisterPrompt title="設定" />;
  }
  // Stripe's way back belongs to the provider it names, never to the one shown in its place.
  const connect = providerNotFound ? null : connectStep(query.connect);
  const payoutOutcome = providerNotFound ? null : payoutConsentOutcomeOrNull(query.payout);
  const section = connect || payoutOutcome ? "payout" : hostSettingsSectionOrNull(query.section);
  if (!section) {
    return (
      <HostPageBody>
        <PageHead title="設定" />
        <HostSettingsIndex
          providerId={provider.id}
          role={provider.memberRole}
          deviceEnabled={config.hostPwaEnabled}
          articlesEnabled={config.hostArticleLinksEnabled}
        />
      </HostPageBody>
    );
  }
  const accountPayout = await loadAccountPayout(session, provider);
  const [{ settings, googleConnection }, payout, liveCalendar, addressLoad] = await Promise.all([
    loadHostConsoleData(provider, { notifications: true, meetingPoint: true }),
    accountPayout ? accountPayout.payout : loadHostPayout(provider, { connect }),
    // カレンダー in http mode (#109): the OWNER's Google connection and bookings feed.
    isHostMock() ? null : loadHostCalendar(provider, { feed: true }),
    // 宛先 (#194): the person's own address (the session's NIHO user); the preview's stays on screen.
    isHostMock() ? null : loadNotificationAddress(provider.id),
  ]);
  if (payout.redirectTo) redirect(payout.redirectTo);
  const notificationAddress = isHostMock()
    ? previewNotificationAddress(settings.notifications?.email.addresses[0] ?? null)
    : addressLoad?.status === "live" ? addressLoad.address : addressLoad?.status === "error" ? "error" as const : null;

  // この端末 (#177): the app, and push on this device while HOST_PUSH_ENABLED is on (P2).
  const devicePanel = config.hostPwaEnabled ? (
    <FieldSection id="settings-device" title="この端末">
      <FieldRow label="アプリ" labelId="settings-device-app-label">
        <HostAppInstall labelId="settings-device-app-label" />
      </FieldRow>
      {config.hostPushEnabled ? (
        <FieldRow label="通知" labelId="settings-device-push-label">
          <HostPushToggle labelId="settings-device-push-label" vapidPublicKey={config.hostPushVapidPublicKey} />
        </FieldRow>
      ) : null}
    </FieldSection>
  ) : null;

  const accountPanel = <AccountPanel session={session} niho={await nihoAccount(session, provider.id, query)} />;
  const payoutPanel = accountPayout
    ? <HostPayoutAccountPanel providerId={provider.id} load={accountPayout.experience} notice={payoutOutcome ? PAYOUT_CONSENT_OUTCOMES[payoutOutcome] : null} />
    : undefined;
  const teamMode = config.hostTeamEnabled && session.kind === "experience" ? "native" as const : providerOperationsEnabled() ? "legacy" as const : "off" as const;

  const showAccountSection = (part: HostSettingsSection) => section === "all" || section === part;
  const accountContent = <div className="grid gap-3.5">
    {showAccountSection("team") ? <HostOperatingTeamPanel providerId={provider.id} role={provider.memberRole} mode={teamMode} /> : null}
    {showAccountSection("articles") && provider.memberRole === "OWNER" && config.hostArticleLinksEnabled ? <HostArticleLinksPanel providerId={provider.id} /> : null}
    {showAccountSection("support") ? <HostSupportSettingsPanel providerId={provider.id} role={provider.memberRole} preview={isHostMock()} /> : null}
    {showAccountSection("device") ? devicePanel : null}
    {showAccountSection("account") ? accountPanel : null}
  </div>;

  return (
    <HostPageBody>
      <PageHead title={HOST_SETTINGS_SECTION_TITLES[section]}>
        {section === "all"
          ? provider.memberRole === "OWNER" && teamMode !== "off" ? <a href="#settings-team" className={consoleButtonClass("secondary")}>共同ホストを管理</a> : null
          : <Link href={withProvider(HOST_SETTINGS_PATH, provider.id)} className={consoleButtonClass("secondary")}>設定へ戻る</Link>}
      </PageHead>
      {/* A confirmed departure starts from that provider and section's saved values. */}
      <HostSettingsForm
        key={`${provider.id}/${section}`}
        section={section}
        providerId={provider.id}
        role={provider.memberRole}
        settings={settings}
        payout={payout.load}
        connectNotice={payout.notice}
        googleConnection={googleConnection}
        liveCalendar={liveCalendar}
        preview={isHostMock()}
        notificationAddress={notificationAddress}
        payoutPanel={payoutPanel}
        bookingGuidesHref={config.experienceHostPublicationApiEnabled ? withProvider("/host/booking-guides", provider.id) : null}
        account={accountContent}
      />
    </HostPageBody>
  );
}
