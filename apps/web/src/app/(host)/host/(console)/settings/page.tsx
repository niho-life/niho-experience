import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { FieldRow, FieldSection } from "@/components/host/fields";
import { HostAppInstall } from "@/components/host/HostAppInstall";
import { HostPushToggle } from "@/components/host/HostPushToggle";
import { HostIcon } from "@/components/host/HostIcon";
import { HostRegisterPrompt } from "@/components/host/HostRegisterPrompt";
import { HostSettingsForm } from "@/components/host/HostSettingsForm";
import { HostOperatingTeamPanel } from "@/components/host/HostOperatingTeamPanel";
import { HostSupportSettingsPanel } from "@/components/host/HostSupportSettingsPanel";
import { consoleButtonClass } from "@/components/host/host-ui";
import { AccountAvatar, HostPageBody, PageHead } from "@/components/host/ui";
import { loadHostCalendar } from "@/host/calendar-server";
import { hostPageContext, loadHostConsoleData, loadHostPayout } from "@/host/data";
import { config } from "@/lib/config";
import { HOST_LOGOUT_PATH } from "@/lib/host/routes";
import { isHostMock } from "@/lib/host/server";
import { providerOperationsEnabled } from "@/lib/host/provider-operations-server";

export const metadata: Metadata = { title: "設定" };

type SearchParams = Record<string, string | string[] | undefined>;

/** Stripe's way back to this page (`?connect=`), as NIHO sets it for the account page's return and refresh URLs. */
function connectStep(value: string | string[] | undefined): "return" | "refresh" | null {
  return value === "return" || value === "refresh" ? value : null;
}

/**
 * 設定 (mock v2): provider (and its review), payout account, calendar (#109), default meeting point,
 * notifications (#109), this device as an app and its push (#177, HOST_PWA_ENABLED / HOST_PUSH_ENABLED) and the NIHO account. `?connect=return` (back from Stripe's page) reads the account from Stripe
 * again first; `?connect=refresh` (its link expired) sends the host back to Stripe with a new one.
 */
export default async function HostSettingsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const query = await searchParams;
  const context = await hostPageContext(query);
  if (!context) return null;
  const { session, provider, providerNotFound } = context;
  if (!provider) return <HostRegisterPrompt title="設定" />;
  // Stripe's way back belongs to the provider it names, never to the one shown in its place.
  const connect = providerNotFound ? null : connectStep(query.connect);
  const [{ settings, googleConnection }, payout, liveCalendar] = await Promise.all([
    loadHostConsoleData(provider, { notifications: true, meetingPoint: true }),
    loadHostPayout(provider, { connect }),
    // カレンダー in http mode (#109): the OWNER's Google connection and bookings feed.
    isHostMock() ? null : loadHostCalendar(provider, session.nihoUserId, { feed: true }),
  ]);
  if (payout.redirectTo) redirect(payout.redirectTo);
  const account = { displayName: session.displayName, iconUrl: session.iconUrl };

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

  const accountPanel = (
    <FieldSection id="settings-account" title="アカウント">
      <FieldRow label="NIHO アカウント" labelId="settings-account-label">
        <div role="group" aria-labelledby="settings-account-label" className="flex min-h-10 flex-wrap items-center gap-2.5">
          <AccountAvatar account={account} className="size-6 text-[0.75rem]" />
          <span>{account.displayName || "NIHO アカウント"}</span>
          <a href={config.nihoWebOrigin} className={consoleButtonClass("secondary", "sm")}>
            <HostIcon name="external" className="size-3.5" />
            NIHO アプリ
          </a>
        </div>
      </FieldRow>
      <div className="border-t border-line pt-3 md:pl-[184px]">
        <form method="post" action={HOST_LOGOUT_PATH} data-niho-navigation-form>
          <button type="submit" className={consoleButtonClass("ghost", "sm")}>
            ログアウト
          </button>
        </form>
      </div>
    </FieldSection>
  );

  return (
    <HostPageBody>
      <PageHead title="設定">{provider.memberRole === "OWNER" && providerOperationsEnabled() ? <a href="#settings-team" className={consoleButtonClass("secondary")}>サブホストを管理</a> : null}</PageHead>
      {/* Keyed by provider: switching providers starts from that provider's values. */}
      <HostSettingsForm
        key={provider.id}
        providerId={provider.id}
        role={provider.memberRole}
        settings={settings}
        payout={payout.load}
        connectNotice={payout.notice}
        googleConnection={googleConnection}
        liveCalendar={liveCalendar}
        preview={isHostMock()}
        account={<><HostOperatingTeamPanel providerId={provider.id} role={provider.memberRole} enabled={providerOperationsEnabled()} /><div className="mt-3.5"><HostSupportSettingsPanel providerId={provider.id} role={provider.memberRole} preview={isHostMock()} /></div>{devicePanel ? <div className="mt-3.5">{devicePanel}</div> : null}<div className="mt-3.5">{accountPanel}</div></>}
      />
    </HostPageBody>
  );
}
