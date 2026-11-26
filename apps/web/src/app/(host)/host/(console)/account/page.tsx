import type { Metadata } from "next";
import Link from "next/link";
import { MemberProfileEditor } from "@/components/host/MemberProfileEditor";
import { FieldRow, FieldSection } from "@/components/host/fields";
import { AccountPanel } from "@/components/host/HostAccountPanel";
import { HostAppInstall } from "@/components/host/HostAppInstall";
import { HostNotificationAddress } from "@/components/host/HostNotificationAddress";
import { HostPushToggle } from "@/components/host/HostPushToggle";
import { HOST_SURFACE } from "@/components/host/host-ui";
import { HostPageBody, InitialAvatar, PageHead } from "@/components/host/ui";
import { hostPageContext, loadHostConsoleData } from "@/host/data";
import { NOTIFICATION_ADDRESS_TEXT, previewNotificationAddress, type HostNotificationAddressView } from "@/host/notification-address";
import { loadNotificationAddress } from "@/host/notification-address-server";
import { config } from "@/lib/config";
import { resolveCalendarContext } from "@/lib/experience/calendar-actor";
import { nihoAccount } from "@/lib/host/niho-account-row-server";
import { providerRoleLabel } from "@/lib/host/providers";
import { HOST_HOME_PATH, withProvider } from "@/lib/host/routes";
import { isHostMock } from "@/lib/host/server";

export const metadata: Metadata = { title: "あなたのアカウント" };

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * あなたのアカウント: the signed-in person's own settings, the same under every provider: the login, where this site's
 * emails go (#194), this device as an app (#177) and the providers they belong to. Also for a person with no provider
 * (a writer, a product operator).
 */
export default async function HostAccountPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const query = await searchParams;
  const context = await hostPageContext(query);
  if (!context) return null;
  const { session, provider, providers } = context;

  // 通知の宛先: the person's own address, read for the provider on screen (a product operator: the one they serve).
  let address: HostNotificationAddressView | "error" | null = null;
  let addressProviderId: string | null = null;
  if (provider) {
    if (isHostMock()) {
      addressProviderId = provider.id;
      const { settings } = await loadHostConsoleData(provider, { notifications: true });
      address = previewNotificationAddress(settings.notifications?.email.addresses[0] ?? null);
    } else {
      // The address is the person's own, and the address API answers for a provider they own: whichever provider is on
      // screen, one they own is asked. Without any, the section is not offered.
      addressProviderId = (provider.memberRole === "OWNER" ? provider : providers.find((item) => item.memberRole === "OWNER"))?.id ?? null;
    }
  } else if (config.hostMailEnabled) {
    const calendar = await resolveCalendarContext(query);
    if (calendar?.choice?.kind === "OPERATOR") addressProviderId = calendar.choice.id;
  }
  if (addressProviderId && address === null) {
    const load = await loadNotificationAddress(addressProviderId);
    address = load.status === "live" ? load.address : load.status === "error" ? "error" : null;
  }

  return (
    <HostPageBody>
      <PageHead title="あなたのアカウント" />
      <p className="-mt-1.5 mb-3.5 text-ink-soft md:mb-[18px]">あなた個人の設定です。</p>
      <div className="grid gap-3.5">
        <AccountPanel session={session} niho={await nihoAccount(session, provider?.id ?? null, query)} />

        {provider && !context.providerNotFound && !isHostMock() && config.experienceHostPublicationApiEnabled
          && (provider.memberRole === "OWNER" || provider.memberRole === "COHOST") ? (
          <FieldSection id="account-member-profile" title="メンバーの紹介">
            <div className="space-y-4 px-4 pb-4 md:px-5">
              <p className="text-sm text-ink-soft">{provider.displayName} のメンバーとして旅行者に見せる紹介です。</p>
              <MemberProfileEditor key={provider.id} api={`/host/api/member-profiles/${encodeURIComponent(provider.id)}`} />
            </div>
          </FieldSection>
        ) : null}

        {addressProviderId && address ? (
          <FieldSection id="account-notification" title="通知の宛先">
            <FieldRow label="宛先" labelId="account-notification-to">
              {address === "error" ? (
                <p role="alert" className="flex min-h-10 items-center text-danger">{NOTIFICATION_ADDRESS_TEXT.loadFailed}</p>
              ) : (
                <HostNotificationAddress providerId={addressProviderId} initial={address} labelId="account-notification-to" />
              )}
            </FieldRow>
          </FieldSection>
        ) : null}

        {config.hostPwaEnabled ? (
          <FieldSection id="account-device" title="この端末">
            <div id="settings-device">
              <FieldRow label="アプリ" labelId="settings-device-app-label">
                <HostAppInstall labelId="settings-device-app-label" />
              </FieldRow>
              {config.hostPushEnabled ? (
                <FieldRow label="通知" labelId="settings-device-push-label">
                  <HostPushToggle labelId="settings-device-push-label" vapidPublicKey={config.hostPushVapidPublicKey} />
                </FieldRow>
              ) : null}
            </div>
          </FieldSection>
        ) : null}

        {providers.length > 0 ? (
          <section id="account-providers" aria-labelledby="account-providers-title" className={`${HOST_SURFACE} overflow-hidden`}>
            <h2 id="account-providers-title" className="px-4 pt-4 pb-2 text-[0.78125rem] font-extrabold text-ink-soft md:px-5">所属している提供者</h2>
            <ul className="divide-y divide-line">
              {providers.map((item) => {
                const selected = item.id === provider?.id;
                const role = providerRoleLabel(item.memberRole);
                return (
                  <li key={item.id} className="flex min-h-[64px] items-center gap-3 px-4 py-3 md:px-5">
                    <InitialAvatar name={item.displayName} />
                    <span className="min-w-0 flex-1 leading-tight">
                      <span className="block truncate font-extrabold">{item.displayName}</span>
                      {role ? <span className="block text-[0.78125rem] text-muted">{role}</span> : null}
                    </span>
                    {selected ? (
                      <span className="text-[0.78125rem] font-extrabold text-muted">表示中</span>
                    ) : (
                      <Link href={withProvider(HOST_HOME_PATH, item.id)} className="font-bold text-moss underline underline-offset-4">開く</Link>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}
      </div>
    </HostPageBody>
  );
}
