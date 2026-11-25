import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { FieldRow, FieldSection } from "@/components/host/fields";
import { AccountPanel } from "@/components/host/HostAccountPanel";
import { HostNotificationAddress } from "@/components/host/HostNotificationAddress";
import { HostRegisterPrompt } from "@/components/host/HostRegisterPrompt";
import { HostSettingsForm } from "@/components/host/HostSettingsForm";
import type { HostSettingsSection } from "@/lib/host/settings-navigation";
import { HostSettingsIndex } from "@/components/host/HostSettingsIndex";
import { HostSupportSettingsPanel } from "@/components/host/HostSupportSettingsPanel";
import { HostPayoutAccountPanel } from "@/components/host/HostPayoutAccountPanel";
import { HostArticleLinksPanel } from "@/components/host/HostArticleLinksPanel";
import { consoleButtonClass } from "@/components/host/host-ui";
import { HostPageBody, PageHead } from "@/components/host/ui";
import { loadHostCalendar } from "@/host/calendar-server";
import { hostPageContext, loadHostConsoleData, loadHostPayout, type HostPayoutData } from "@/host/data";
import { hostPayoutLoadOf, PAYOUT_CONSENT_OUTCOMES, payoutConsentOutcomeOrNull, type ExperiencePayoutLoad } from "@/host/payout-account";
import { loadExperiencePayout } from "@/host/payout-account-server";
import { NOTIFICATION_ADDRESS_TEXT, previewNotificationAddress } from "@/host/notification-address";
import { loadNotificationAddress } from "@/host/notification-address-server";
import { config } from "@/lib/config";
import { resolveCalendarContext } from "@/lib/experience/calendar-actor";
import { nihoAccount } from "@/lib/host/niho-account-row-server";
import { HOST_ACCOUNT_PATH, HOST_MEMBERS_PATH, HOST_SETTINGS_PATH, withProvider } from "@/lib/host/routes";
import { HOST_SETTINGS_SECTION_TITLES, hostSettingsForwardPath, hostSettingsSectionOrNull } from "@/lib/host/settings-navigation";
import type { HostSession } from "@/lib/host/session";
import { isHostMock } from "@/lib/host/server";
import { hostTeamMode } from "@/lib/host/team-mode-server";

export const metadata: Metadata = { title: "設定" };

type SearchParams = Record<string, string | string[] | undefined>;

/** Stripe's way back to this page (`?connect=`), as NIHO sets it for the account page's return and refresh URLs. */
function connectStep(value: string | string[] | undefined): "return" | "refresh" | null {
  return value === "return" || value === "refresh" ? value : null;
}

/**
 * 設定 for a product operator (#194, docs/product-operators.md): no provider settings, only where this site's emails go
 * (the OTA bookings of their products come to them) and the account. Only while this site emails hosts.
 */
async function OperatorSettings({ providerId, session, niho }: { providerId: string; session: HostSession; niho: Awaited<ReturnType<typeof nihoAccount>> }) {
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

/**
 * 設定 (mock v2): provider (and its review), payout account, calendar (#109), default meeting point,
 * notifications (#109). The person's own settings (login, address #194, this device) are /host/account and the team is
 * /host/members; their old `?section=` values forward there. `?connect=return` (back from Stripe's page) reads the account from Stripe
 * again first; `?connect=refresh` (its link expired) sends the host back to Stripe with a new one. With Experience host
 * accounts 受取口座 is the account Admin/ops registered, read from Stripe, with the OWNER's consent (`?payout=` after its
 * form says what happened).
 */
export default async function HostSettingsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const query = await searchParams;
  // 設定 › チーム / この端末 / ログイン情報 moved (old bookmarks, and the fragments of the old sections, land here first).
  const forwardTo = hostSettingsForwardPath(query);
  if (forwardTo) redirect(forwardTo);
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
        <PageHead title={`${provider.displayName} の設定`} />
        <p className="-mt-1.5 mb-3.5 text-ink-soft md:mb-[18px]">
          この提供者に関わる設定です。あなた個人の設定は「<Link href={withProvider(HOST_ACCOUNT_PATH, provider.id)} className="font-bold text-moss underline underline-offset-4">アカウント設定</Link>」にあります。
        </p>
        <HostSettingsIndex
          providerId={provider.id}
          role={provider.memberRole}
          articlesEnabled={config.hostArticleLinksEnabled || config.nihoWriterEnabled}
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

  const payoutPanel = accountPayout
    ? <HostPayoutAccountPanel providerId={provider.id} load={accountPayout.experience} notice={payoutOutcome ? PAYOUT_CONSENT_OUTCOMES[payoutOutcome] : null} />
    : undefined;
  const teamMode = hostTeamMode(session);

  // Provider-wide only: the person's own settings (login, device, address) are at /host/account, the team at /host/members.
  const showAccountSection = (part: HostSettingsSection) => section === "all" || section === part;
  const accountContent = <div className="grid gap-3.5">
    {showAccountSection("articles") && provider.memberRole === "OWNER" && (config.hostArticleLinksEnabled || config.nihoWriterEnabled) ? <HostArticleLinksPanel providerId={provider.id} /> : null}
    {showAccountSection("support") ? <HostSupportSettingsPanel providerId={provider.id} role={provider.memberRole} preview={isHostMock()} /> : null}
  </div>;

  return (
    <HostPageBody>
      <PageHead title={HOST_SETTINGS_SECTION_TITLES[section]}>
        {section === "all"
          ? provider.memberRole === "OWNER" && teamMode !== "off" ? <Link href={withProvider(HOST_MEMBERS_PATH, provider.id)} className={consoleButtonClass("secondary")}>共同ホストを管理</Link> : null
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
